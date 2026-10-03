import Darwin
import Foundation
import UIKit

/// Monotonic time for every RoadScope writer.
///
/// `mach_continuous_time()` keeps advancing while the device sleeps.
/// `mach_absolute_time()` and `ProcessInfo.systemUptime` do not, and locked
/// long-run collection is mostly sleep, so using either would make the two
/// platforms systematically incomparable. Required by
/// `contracts/location-log/v1` §3 and reused here so telemetry and samples
/// share one time domain.
enum MonotonicClock {
  static func continuousMicroseconds() -> Int64 {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    let ticks = mach_continuous_time()
    // Quotient/remainder avoids overflowing ticks * numer on long device uptime.
    let denominator = UInt64(info.denom) * 1000
    return Int64((ticks / denominator) * UInt64(info.numer) +
      (ticks % denominator) * UInt64(info.numer) / denominator)
  }
}

/// Publicly observable device and app state at one instant.
///
/// `nil` means iOS did not give us a value. iOS has **no public lock-screen
/// API**, so `screenInteractive` and `keyguardLocked` are always `nil` here and
/// background is never renamed to "locked". `protectedDataAvailable` is the
/// closest public signal and is recorded under its own name: `false` usually
/// follows a lock, but `true` does not prove the device is unlocked.
struct TelemetryObservation: Equatable {
  var batteryPercent: Int?
  var batteryCharging: Bool?
  var batteryPowerSource: String = TelemetryObservation.powerSourceUnknown
  var powerSaveMode: Bool?
  var screenInteractive: Bool?
  var keyguardLocked: Bool?
  var protectedDataAvailable: Bool?
  var screenStateSource: String = TelemetryObservation.screenSourceIOS
  var appLifecycle: String = TelemetryObservation.lifecycleUnknown
  var locationServiceState: String = TelemetryObservation.serviceUnknown
  var locationServiceDetail: String?
  var processRestartCount: Int = 0
  var resumeReason: String?

  static let powerSourceUnknown = "unknown"
  static let lifecycleUnknown = "unknown"
  static let serviceUnknown = "unknown"
  /// Names what the screen fields actually came from, so a reader never reads a
  /// `nil` as "not locked".
  static let screenSourceIOS = "ios_no_public_lock_api_protected_data_only"

  /// Field names whose value differs from `other`; used for `reasons`.
  func changes(from other: TelemetryObservation) -> [String] {
    var changed: [String] = []
    if batteryPercent != other.batteryPercent { changed.append("battery_percent") }
    if batteryCharging != other.batteryCharging { changed.append("battery_charging") }
    if batteryPowerSource != other.batteryPowerSource { changed.append("battery_power_source") }
    if powerSaveMode != other.powerSaveMode { changed.append("power_save_mode") }
    if screenInteractive != other.screenInteractive { changed.append("screen_interactive") }
    if keyguardLocked != other.keyguardLocked { changed.append("keyguard_locked") }
    if protectedDataAvailable != other.protectedDataAvailable { changed.append("protected_data_available") }
    if appLifecycle != other.appLifecycle { changed.append("app_lifecycle") }
    if locationServiceState != other.locationServiceState { changed.append("location_service_state") }
    if locationServiceDetail != other.locationServiceDetail { changed.append("location_service_detail") }
    if processRestartCount != other.processRestartCount { changed.append("process_restart_count") }
    if resumeReason != other.resumeReason { changed.append("resume_reason") }
    return changed
  }
}

/// Append-only writer for the app-local diagnostics telemetry log.
///
/// Separate file, separate `telemetryVersion`, separate sequence space: nothing
/// here touches `contracts/location-log/v1`, its `recordType`, its `eventType`
/// or its sequence rules, and no position data is ever written.
///
/// Row building is pure Foundation so it can be unit tested on a Mac without a
/// device; only `DeviceTelemetryMonitor` needs UIKit.
final class DiagnosticsTelemetryWriter {
  static let telemetryVersion = 1
  static let recordType = "diagnostics_telemetry"
  static let defaultHeartbeatSeconds: TimeInterval = 300

  enum Trigger: String {
    case recordingStarted = "recording_started"
    case recordingResumed = "recording_resumed"
    case recordingStopped = "recording_stopped"
    /// A segment that ended without writing its own closing row, noticed
    /// afterwards by a later process. Its timestamps are **when the
    /// interruption was noticed**, not when it happened; the actual end is
    /// bounded by `locationLogLastSequence` and the previous row's time. The
    /// device observables stay unavailable on purpose, because we do not know
    /// what the device looked like when the segment died.
    case recordingInterrupted = "recording_interrupted"
    case locationService = "location_service"
    case stateChange = "state_change"
    case heartbeat
  }

  private let url: URL
  private let recordingId: String
  private let sourceId: String
  private let appVersion: String
  private let heartbeatSeconds: TimeInterval

  private(set) var sequence = 0
  private var last: TelemetryObservation?
  private var lastWriteMonotonicUs: Int64?
  private var pendingTruncatedBytes = 0

  init(url: URL, recordingId: String, sourceId: String, appVersion: String,
       heartbeatSeconds: TimeInterval = DiagnosticsTelemetryWriter.defaultHeartbeatSeconds) {
    self.url = url
    self.recordingId = recordingId
    self.sourceId = sourceId
    self.appVersion = appVersion
    self.heartbeatSeconds = heartbeatSeconds
  }

  private static let alwaysWrite: Set<Trigger> = [
    .recordingStarted, .recordingResumed, .recordingStopped, .recordingInterrupted,
    .locationService,
  ]

  /// Repairs an incomplete tail and restores the sequence and last-written
  /// state, so change detection survives a process restart.
  ///
  /// Unparseable complete rows are left alone: a diagnostics file is never
  /// worth destroying, and the Dart reader counts bad lines instead.
  func recover() {
    guard FileManager.default.fileExists(atPath: url.path),
      let data = try? Data(contentsOf: url) else { return }
    let end = data.lastIndex(of: 0x0a).map { $0 + 1 } ?? 0
    if let text = String(data: data.prefix(end), encoding: .utf8) {
      for line in text.split(separator: "\n") {
        guard let row = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
          row["recordType"] as? String == DiagnosticsTelemetryWriter.recordType,
          row["recordingId"] as? String == recordingId else { continue }
        if let recovered = row["telemetrySequence"] as? Int, recovered >= sequence {
          sequence = recovered + 1
        }
        last = DiagnosticsTelemetryWriter.observation(from: row)
      }
    }
    pendingTruncatedBytes = data.count - end
    if pendingTruncatedBytes > 0, let handle = try? FileHandle(forWritingTo: url) {
      try? handle.truncate(atOffset: UInt64(end))
      try? handle.synchronize()
      try? handle.close()
    }
  }

  /// Appends one row when it carries new information. Returns whether it wrote.
  ///
  /// State changes that change nothing and heartbeats inside
  /// `heartbeatSeconds` are dropped, so an idle recording costs almost no
  /// wakeups or flash writes.
  @discardableResult
  func record(_ trigger: Trigger, _ observation: TelemetryObservation,
              utc: Date?, monotonicUs: Int64?, deviceBootId: String?,
              locationLogLastSequence: Int) -> Bool {
    // The interrupted marker deliberately claims nothing about the device, so
    // a field-by-field diff against the last row would read as if the battery
    // and screen had just become unavailable. Name the real reason.
    let changes: [String]
    if trigger == .recordingInterrupted {
      changes = ["previous_segment_not_closed"]
    } else {
      changes = last.map { observation.changes(from: $0) } ?? ["initial_snapshot"]
    }
    if !DiagnosticsTelemetryWriter.alwaysWrite.contains(trigger) {
      if trigger == .heartbeat {
        if let since = lastWriteMonotonicUs, let now = monotonicUs,
          Double(now - since) / 1_000_000 < heartbeatSeconds { return false }
      } else if changes.isEmpty {
        return false
      }
    }
    let row = self.row(trigger, observation, utc: utc, monotonicUs: monotonicUs,
                       deviceBootId: deviceBootId,
                       locationLogLastSequence: locationLogLastSequence,
                       reasons: changes)
    do {
      try append(row)
    } catch {
      return false // Diagnostics must never take the recorder down with it.
    }
    // Advance only after a durable append, matching the location log.
    sequence += 1
    last = observation
    if let now = monotonicUs { lastWriteMonotonicUs = now }
    pendingTruncatedBytes = 0
    return true
  }

  /// Pure row construction, exposed for unit testing without a device.
  func row(_ trigger: Trigger, _ observation: TelemetryObservation,
           utc: Date?, monotonicUs: Int64?, deviceBootId: String?,
           locationLogLastSequence: Int, reasons: [String]) -> [String: Any] {
    var unavailable: [String] = []
    if observation.batteryPercent == nil { unavailable.append("battery_percent_unavailable") }
    if observation.batteryCharging == nil { unavailable.append("battery_charging_unavailable") }
    if observation.batteryPowerSource == TelemetryObservation.powerSourceUnknown {
      unavailable.append("battery_power_source_unknown")
    }
    if observation.powerSaveMode == nil { unavailable.append("power_save_mode_unavailable") }
    if observation.screenInteractive == nil { unavailable.append("screen_interactive_unavailable") }
    if observation.keyguardLocked == nil { unavailable.append("keyguard_state_unavailable") }
    if observation.protectedDataAvailable == nil { unavailable.append("protected_data_state_unavailable") }
    if observation.appLifecycle == TelemetryObservation.lifecycleUnknown {
      unavailable.append("app_lifecycle_unknown")
    }
    if observation.locationServiceState == TelemetryObservation.serviceUnknown {
      unavailable.append("location_service_state_unknown")
    }
    if deviceBootId == nil { unavailable.append("device_boot_id_unavailable") }
    if utc == nil { unavailable.append("utc_time_unavailable") }
    if monotonicUs == nil { unavailable.append("monotonic_time_unavailable") }

    return [
      "telemetryVersion": DiagnosticsTelemetryWriter.telemetryVersion,
      "recordType": DiagnosticsTelemetryWriter.recordType,
      "recordingId": recordingId,
      "sourceId": sourceId,
      "platform": "ios",
      "appVersion": appVersion,
      "deviceBootId": (deviceBootId as Any?) ?? NSNull(),
      "telemetrySequence": sequence,
      "trigger": trigger.rawValue,
      "reasons": reasons,
      "occurredAtUtc": (utc.map(DiagnosticsTelemetryWriter.iso) as Any?) ?? NSNull(),
      "occurredMonotonicUs": (monotonicUs as Any?) ?? NSNull(),
      "locationLogLastSequence": locationLogLastSequence,
      "batteryPercent": (observation.batteryPercent as Any?) ?? NSNull(),
      "batteryCharging": (observation.batteryCharging as Any?) ?? NSNull(),
      "batteryPowerSource": observation.batteryPowerSource,
      "powerSaveMode": (observation.powerSaveMode as Any?) ?? NSNull(),
      "screenInteractive": (observation.screenInteractive as Any?) ?? NSNull(),
      "keyguardLocked": (observation.keyguardLocked as Any?) ?? NSNull(),
      "protectedDataAvailable": (observation.protectedDataAvailable as Any?) ?? NSNull(),
      "screenStateSource": observation.screenStateSource,
      "appLifecycle": observation.appLifecycle,
      "locationServiceState": observation.locationServiceState,
      "locationServiceDetail": (observation.locationServiceDetail as Any?) ?? NSNull(),
      "processRestartCount": observation.processRestartCount,
      "resumeReason": (observation.resumeReason as Any?) ?? NSNull(),
      "recoveredTruncatedBytes": pendingTruncatedBytes > 0 ? pendingTruncatedBytes : NSNull(),
      "unavailable": unavailable,
    ]
  }

  static func observation(from row: [String: Any]) -> TelemetryObservation {
    var observation = TelemetryObservation()
    observation.batteryPercent = row["batteryPercent"] as? Int
    observation.batteryCharging = row["batteryCharging"] as? Bool
    observation.batteryPowerSource = row["batteryPowerSource"] as? String
      ?? TelemetryObservation.powerSourceUnknown
    observation.powerSaveMode = row["powerSaveMode"] as? Bool
    observation.screenInteractive = row["screenInteractive"] as? Bool
    observation.keyguardLocked = row["keyguardLocked"] as? Bool
    observation.protectedDataAvailable = row["protectedDataAvailable"] as? Bool
    observation.screenStateSource = row["screenStateSource"] as? String
      ?? TelemetryObservation.screenSourceIOS
    observation.appLifecycle = row["appLifecycle"] as? String ?? TelemetryObservation.lifecycleUnknown
    observation.locationServiceState = row["locationServiceState"] as? String
      ?? TelemetryObservation.serviceUnknown
    observation.locationServiceDetail = row["locationServiceDetail"] as? String
    observation.processRestartCount = row["processRestartCount"] as? Int ?? 0
    observation.resumeReason = row["resumeReason"] as? String
    return observation
  }

  static func iso(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }

  private func append(_ row: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
    var directory = url.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try directory.setResourceValues(values)
    if !FileManager.default.fileExists(atPath: url.path) {
      guard FileManager.default.createFile(atPath: url.path, contents: nil,
        attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]) else {
        throw NSError(domain: "RoadScope", code: 2,
          userInfo: [NSLocalizedDescriptionKey: "Cannot create telemetry file"])
      }
    }
    let handle = try FileHandle(forWritingTo: url)
    defer { try? handle.close() }
    try handle.seekToEnd()
    try handle.write(contentsOf: data + Data([0x0a]))
    try handle.synchronize()
  }
}

/// Observes the iOS state that explains a recording afterwards.
///
/// Writes on state change plus a low-frequency heartbeat. The heartbeat uses a
/// run-loop timer, so it does not fire while iOS has the process suspended;
/// gaps in telemetry are therefore expected and are not proof of a recording
/// gap. Everything runs on the main thread, like the rest of the plugin, so
/// there is a single writer per file.
final class DeviceTelemetryMonitor {
  private let writer: DiagnosticsTelemetryWriter
  private let deviceBootId: () -> String?
  private let locationLogLastSequence: () -> Int
  private let heartbeatSeconds: TimeInterval
  private let device = UIDevice.current
  private let center = NotificationCenter.default

  private var observers: [NSObjectProtocol] = []
  private var heartbeat: Timer?
  private var locationServiceState = TelemetryObservation.serviceUnknown
  private var locationServiceDetail: String?
  private var processRestartCount = 0
  private var resumeReason: String?
  private var running = false

  init(writer: DiagnosticsTelemetryWriter, deviceBootId: @escaping () -> String?,
       locationLogLastSequence: @escaping () -> Int,
       heartbeatSeconds: TimeInterval = DiagnosticsTelemetryWriter.defaultHeartbeatSeconds) {
    self.writer = writer
    self.deviceBootId = deviceBootId
    self.locationLogLastSequence = locationLogLastSequence
    self.heartbeatSeconds = heartbeatSeconds
  }

  deinit { teardown() }

  func start(serviceState: String, restartCount: Int, resume: String?) {
    guard !running else { return }
    running = true
    processRestartCount = restartCount
    resumeReason = resume
    locationServiceState = serviceState
    device.isBatteryMonitoringEnabled = true
    writer.recover()
    let names: [Notification.Name] = [
      UIDevice.batteryLevelDidChangeNotification,
      UIDevice.batteryStateDidChangeNotification,
      UIApplication.didBecomeActiveNotification,
      UIApplication.willResignActiveNotification,
      UIApplication.didEnterBackgroundNotification,
      UIApplication.willEnterForegroundNotification,
      UIApplication.willTerminateNotification,
      UIApplication.protectedDataWillBecomeUnavailableNotification,
      UIApplication.protectedDataDidBecomeAvailableNotification,
      // This app is scene based, so watch both levels: UIKit still posts the
      // UIApplication ones, and the scene ones are the precise transitions.
      UIScene.didActivateNotification,
      UIScene.willDeactivateNotification,
      UIScene.didEnterBackgroundNotification,
      UIScene.willEnterForegroundNotification,
      .NSProcessInfoPowerStateDidChange,
    ]
    for name in names {
      observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        self?.record(.stateChange)
      })
    }
    record(resume == nil ? .recordingStarted : .recordingResumed)
    let timer = Timer(timeInterval: heartbeatSeconds, repeats: true) { [weak self] _ in
      self?.record(.heartbeat)
    }
    timer.tolerance = heartbeatSeconds / 10
    RunLoop.main.add(timer, forMode: .common)
    heartbeat = timer
  }

  func stop(serviceState: String, detail: String? = nil) {
    guard running else { return }
    locationServiceState = serviceState
    locationServiceDetail = detail
    record(.recordingStopped)
    running = false
    teardown()
  }

  /// Records a location service transition such as a restart or a failure.
  func noteLocationService(_ state: String, detail: String? = nil) {
    locationServiceState = state
    locationServiceDetail = detail
    if running { record(.locationService) }
  }

  func observe() -> TelemetryObservation {
    var observation = TelemetryObservation()
    let level = device.batteryLevel
    observation.batteryPercent = level >= 0 ? Int((level * 100).rounded()) : nil
    switch device.batteryState {
    case .charging, .full:
      observation.batteryCharging = true
      // iOS exposes no public plug type, so the source stays explicitly unknown.
      observation.batteryPowerSource = TelemetryObservation.powerSourceUnknown
    case .unplugged:
      observation.batteryCharging = false
      observation.batteryPowerSource = "none"
    case .unknown:
      observation.batteryCharging = nil
      observation.batteryPowerSource = TelemetryObservation.powerSourceUnknown
    @unknown default:
      observation.batteryCharging = nil
      observation.batteryPowerSource = TelemetryObservation.powerSourceUnknown
    }
    observation.powerSaveMode = ProcessInfo.processInfo.isLowPowerModeEnabled
    // iOS has no public lock-screen API; these stay nil rather than guessing.
    observation.screenInteractive = nil
    observation.keyguardLocked = nil
    observation.protectedDataAvailable = UIApplication.shared.isProtectedDataAvailable
    observation.screenStateSource = TelemetryObservation.screenSourceIOS
    switch UIApplication.shared.applicationState {
    case .active: observation.appLifecycle = "foreground"
    case .inactive: observation.appLifecycle = "inactive"
    case .background: observation.appLifecycle = "background"
    @unknown default: observation.appLifecycle = TelemetryObservation.lifecycleUnknown
    }
    observation.locationServiceState = locationServiceState
    observation.locationServiceDetail = locationServiceDetail
    observation.processRestartCount = processRestartCount
    observation.resumeReason = resumeReason
    return observation
  }

  private func record(_ trigger: DiagnosticsTelemetryWriter.Trigger) {
    writer.record(trigger, observe(), utc: Date(),
                  monotonicUs: MonotonicClock.continuousMicroseconds(),
                  deviceBootId: deviceBootId(),
                  locationLogLastSequence: locationLogLastSequence())
  }

  private func teardown() {
    heartbeat?.invalidate()
    heartbeat = nil
    for observer in observers { center.removeObserver(observer) }
    observers.removeAll()
  }
}
