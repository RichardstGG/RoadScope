import CoreLocation
import Darwin
import Flutter
import Foundation

// Flutter method calls and this CLLocationManager delegate run on the main
// thread. All event/sample appends go through append(), in that same order.
public class DeviceBridgePlugin: NSObject, FlutterPlugin, CLLocationManagerDelegate {
  private let manager = CLLocationManager()
  private let defaults = UserDefaults.standard
  private var sequence = 0
  private var segmentStarted = false
  private var resuming = false
  private var bootId = ""
  private var bootAnchor: Int64 = 0
  private let thresholdMs: Int64 = 60_000
  private var telemetry: DeviceTelemetryMonitor?
  private var startRequestedInThisProcess = false
  private var recordingId: String? { defaults.string(forKey: "roadscope.recordingId") }
  private var logURL: URL? {
    guard let id = recordingId else { return nil }
    return FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("recordings", isDirectory: true).appendingPathComponent("\(id).ndjson")
  }
  /// Diagnostics telemetry gets its own directory and file so an export can
  /// never mix it with the location-log v1 record stream.
  private var telemetryURL: URL? {
    guard let id = recordingId else { return nil }
    return FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("diagnostics", isDirectory: true)
      .appendingPathComponent("\(id).telemetry.ndjson")
  }

  public static func register(with registrar: FlutterPluginRegistrar) {
    let channel = FlutterMethodChannel(name: "device_bridge", binaryMessenger: registrar.messenger())
    registrar.addMethodCallDelegate(DeviceBridgePlugin(), channel: channel)
  }

  override init() {
    super.init()
    manager.delegate = self
    manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
    manager.distanceFilter = kCLDistanceFilterNone
    resuming = defaults.bool(forKey: "roadscope.active")
    // A stored intent is not proof that Core Location is still active. Wait
    // for an explicit foreground `start` call so relaunching the UI cannot
    // silently resume location collection.
  }

  public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    dispatchPrecondition(condition: .onQueue(.main))
    switch call.method {
    case "start":
      startRequestedInThisProcess = true
      if !defaults.bool(forKey: "roadscope.active") {
        defaults.set(UUID().uuidString, forKey: "roadscope.recordingId")
        defaults.set(true, forKey: "roadscope.active")
        defaults.set("waiting_permission", forKey: "roadscope.state")
        sequence = 0
        segmentStarted = false
        resuming = false
      }
      if CLLocationManager.locationServicesEnabled() {
        manager.requestAlwaysAuthorization()
        activateIfAuthorized()
        result(nil)
      } else {
        fail("Location services are disabled")
        result(FlutterError(code: "location_disabled", message: "Enable Location Services", details: nil))
      }
    case "stop":
      // A segment this plugin instance never ran, while the stored state still
      // says active, means the previous process died without closing its
      // telemetry. Nothing else would ever mark that.
      let interrupted = telemetry == nil && defaults.bool(forKey: "roadscope.active")
      telemetry?.stop(serviceState: "stopped")
      telemetry = nil
      if interrupted { markInterrupted() }
      manager.stopUpdatingLocation()
      manager.allowsBackgroundLocationUpdates = false
      defaults.set(false, forKey: "roadscope.active")
      defaults.set("idle", forKey: "roadscope.state")
      defaults.removeObject(forKey: "roadscope.error")
      segmentStarted = false
      startRequestedInThisProcess = false
      result(nil)
    case "status":
      let persistedState = defaults.string(forKey: "roadscope.state") ?? "idle"
      let visibleState = defaults.bool(forKey: "roadscope.active")
        && !segmentStarted && !startRequestedInThisProcess
        ? "interrupted" : persistedState
      result([
        "state": visibleState,
        "recordingId": (recordingId as Any?) ?? NSNull(),
        "logPath": (logURL?.path as Any?) ?? NSNull(),
        "telemetryPath": (telemetryURL?.path as Any?) ?? NSNull(),
        "error": (defaults.string(forKey: "roadscope.error") as Any?) ?? NSNull(),
        "sampleAgeMs": sampleAgeMs() as Any,
      ])
    case "readLog":
      result(read(logURL))
    // Diagnostics telemetry is a separate file, never merged into the log.
    case "readTelemetry":
      result(read(telemetryURL))
    default: result(FlutterMethodNotImplemented)
    }
  }

  /// Writes the one telemetry row that says "the previous segment ended
  /// without closing itself". The location log is not touched: it has no event
  /// for this, and adding one would need a contract change.
  private func markInterrupted() {
    guard let url = telemetryURL, let id = recordingId else { return }
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
    let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
    let writer = DiagnosticsTelemetryWriter(url: url, recordingId: id,
      sourceId: "ios-corelocation", appVersion: "\(version)+\(build)")
    writer.recover()
    var observation = TelemetryObservation()
    observation.locationServiceDetail = "previous process ended without a closing telemetry row"
    observation.processRestartCount = defaults.integer(forKey: "roadscope.restartCount")
    writer.record(.recordingInterrupted, observation, utc: Date(),
                  monotonicUs: MonotonicClock.continuousMicroseconds(),
                  deviceBootId: defaults.string(forKey: "roadscope.bootId"),
                  locationLogLastSequence: lastLoggedSequence())
  }

  /// Highest sample sequence actually present in the log, or -1. Read-only.
  private func lastLoggedSequence() -> Int {
    guard let url = logURL, let text = try? String(contentsOf: url, encoding: .utf8) else { return -1 }
    var last = -1
    for line in text.split(separator: "\n") {
      guard let row = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
        row["recordType"] as? String == "sample", let seq = row["sequence"] as? Int else { continue }
      last = max(last, seq)
    }
    return last
  }

  private func read(_ url: URL?) -> String {
    guard let url, FileManager.default.fileExists(atPath: url.path) else { return "" }
    return (try? String(contentsOf: url, encoding: .utf8)) ?? ""
  }

  private var lastReceivedMono: Int64?
  private var lastMeasurementAgeMs: Double = 0
  private func sampleAgeMs() -> Any {
    guard segmentStarted, let last = lastReceivedMono else { return NSNull() }
    return lastMeasurementAgeMs + Double(monotonicUs() - last) / 1000
  }

  public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) { activateIfAuthorized() }

  private func activateIfAuthorized() {
    dispatchPrecondition(condition: .onQueue(.main))
    guard defaults.bool(forKey: "roadscope.active") else { return }
    switch manager.authorizationStatus {
    case .authorizedAlways, .authorizedWhenInUse:
      guard !segmentStarted else { return }
      do {
        try startSegment()
        segmentStarted = true
        manager.allowsBackgroundLocationUpdates = true
        manager.pausesLocationUpdatesAutomatically = false
        manager.startUpdatingLocation()
        defaults.set("recording", forKey: "roadscope.state")
        defaults.removeObject(forKey: "roadscope.error")
      } catch { fail("Location start failed: \(error.localizedDescription)") }
    case .denied, .restricted: fail("Location permission denied")
    case .notDetermined: defaults.set("waiting_permission", forKey: "roadscope.state")
    @unknown default: fail("Unknown location authorization state")
    }
  }

  private func startSegment() throws {
    let now = Date(), mono = monotonicUs()
    let anchor = utcMs(now) - mono / 1000
    var oldId = defaults.string(forKey: "roadscope.bootId") ?? UUID().uuidString
    var oldAnchor = (defaults.object(forKey: "roadscope.continuousBootAnchorMs") as? NSNumber)?.int64Value ?? anchor
    var lastMono: Int64 = 0
    var truncated = 0
    sequence = 0
    if let url = logURL, FileManager.default.fileExists(atPath: url.path) {
      let data = try Data(contentsOf: url)
      let end = data.lastIndex(of: 0x0a).map { $0 + 1 } ?? 0
      let complete = data.prefix(end)
      guard let text = String(data: complete, encoding: .utf8) else { throw logError("Invalid UTF-8") }
      for line in text.split(separator: "\n") where !line.trimmingCharacters(in: .whitespaces).isEmpty {
        guard let row = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
          row["recordType"] is String else { throw logError("舊格式紀錄已保留；請開始新紀錄") }
        guard row["recordingId"] as? String == recordingId else { throw logError("Recording identity mismatch") }
        guard row["schemaVersion"] as? Int == 1, row["sourceId"] as? String == "ios-corelocation",
          let recordedBootId = row["deviceBootId"] as? String else { throw logError("Invalid recovered record") }
        oldId = recordedBootId
        if let recordedAnchor = row["bootAnchorUtcMs"] as? Int64 { oldAnchor = recordedAnchor }
        if row["recordType"] as? String == "sample" {
          guard let seq = row["sequence"] as? Int, seq >= sequence,
            let received = row["receivedMonotonicUs"] as? Int64 else { throw logError("Invalid recovered sample") }
          sequence = seq + 1
          lastMono = received
        } else if row["recordType"] as? String == "event" {
          guard let occurred = row["occurredMonotonicUs"] as? Int64 else { throw logError("Invalid recovered event") }
          lastMono = occurred
        }
      }
      truncated = data.count - end
      if truncated > 0 {
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.truncate(atOffset: UInt64(end))
        try handle.synchronize()
      }
    }
    let rebooted = lastMono > mono
    let changed = abs(anchor - oldAnchor) >= thresholdMs || rebooted
    bootId = changed ? UUID().uuidString : oldId
    bootAnchor = anchor
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
    let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
    try event("recording_started", now, mono, [
      "platform": "ios", "appVersion": "\(version)+\(build)", "sourceType": "phone_location",
      "sourceCapabilities": ["measurementMonotonic": false, "monotonicIncludesSleep": true],
      "bootAnchorUtcMs": anchor,
    ])
    if resuming && changed { try clockEvent(oldId, oldAnchor, now, mono) }
    if truncated > 0 { try event("log_truncated", now, mono, ["truncatedBytes": truncated, "resumedSequence": sequence]) }
    if resuming { try event("recording_resumed", now, mono, ["reason": rebooted ? "boot" : "process_restart", "resumedSequence": sequence]) }
    persistClock()
    lastReceivedMono = nil
    startTelemetry(appVersion: "\(version)+\(build)", resumed: resuming, rebooted: rebooted)
  }

  /// Diagnostics telemetry is best-effort: a failure here must not stop the
  /// recording it is only meant to describe.
  private func startTelemetry(appVersion: String, resumed: Bool, rebooted: Bool) {
    telemetry?.stop(serviceState: "restarted", detail: "superseded by a new location segment")
    guard let url = telemetryURL, let id = recordingId else { telemetry = nil; return }
    let restarts = resumed ? defaults.integer(forKey: "roadscope.restartCount") + 1 : 0
    defaults.set(restarts, forKey: "roadscope.restartCount")
    let monitor = DeviceTelemetryMonitor(
      writer: DiagnosticsTelemetryWriter(url: url, recordingId: id,
        sourceId: "ios-corelocation", appVersion: appVersion),
      deviceBootId: { [weak self] in self?.bootId },
      locationLogLastSequence: { [weak self] in (self?.sequence ?? 0) - 1 })
    telemetry = monitor
    monitor.start(serviceState: resumed ? "restarted" : "started", restartCount: restarts,
      resume: resumed ? (rebooted ? "boot" : "process_restart") : nil)
  }

  public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    dispatchPrecondition(condition: .onQueue(.main))
    guard segmentStarted, defaults.bool(forKey: "roadscope.active"), let id = recordingId else { return }
    for location in locations {
      let now = Date(), mono = monotonicUs()
      do {
        let anchor = utcMs(now) - mono / 1000
        if abs(anchor - bootAnchor) >= thresholdMs {
          let oldId = bootId, oldAnchor = bootAnchor
          bootId = UUID().uuidString; bootAnchor = anchor
          try clockEvent(oldId, oldAnchor, now, mono)
          persistClock()
        }
        var flags = ["measurement_monotonic_unavailable"]
        func value(_ number: Double, _ valid: Bool, _ flag: String) -> Any {
          if valid && number.isFinite { return number }
          flags.append(flag)
          return NSNull()
        }
        let speed = value(location.speed, location.speed >= 0, "speed_unavailable")
        let heading = value(location.course, location.course >= 0 && location.course < 360, "heading_unavailable")
        let horizontal = value(location.horizontalAccuracy, location.horizontalAccuracy >= 0, "horizontal_accuracy_unavailable")
        let altitude = value(location.altitude, location.verticalAccuracy >= 0, "altitude_unavailable")
        let speedAccuracy = value(location.speedAccuracy, location.speedAccuracy >= 0, "speed_accuracy_unavailable")
        try append([
          "schemaVersion": 1, "recordType": "sample", "recordingId": id,
          "sourceId": "ios-corelocation", "sourceType": "phone_location", "deviceBootId": bootId,
          "sequence": sequence, "measuredAtUtc": iso(location.timestamp), "receivedAtUtc": iso(now),
          "measurementMonotonicUs": NSNull(), "receivedMonotonicUs": mono,
          "latDeg": location.coordinate.latitude, "lonDeg": location.coordinate.longitude,
          "altitudeM": altitude, "speedMps": speed, "headingDeg": heading,
          "horizontalAccuracyM": horizontal, "speedAccuracyMps": speedAccuracy, "qualityFlags": flags,
        ])
        sequence += 1
        lastReceivedMono = mono
        lastMeasurementAgeMs = max(0, now.timeIntervalSince(location.timestamp) * 1000)
      } catch { fail("Location write failed: \(error.localizedDescription)"); return }
    }
  }

  private func clockEvent(_ oldId: String, _ oldAnchor: Int64, _ now: Date, _ mono: Int64) throws {
    try event("clock_adjusted", now, mono, ["previousDeviceBootId": oldId,
      "previousBootAnchorUtcMs": oldAnchor, "bootAnchorUtcMs": bootAnchor, "thresholdMs": thresholdMs])
  }

  private func event(_ type: String, _ now: Date, _ mono: Int64, _ extra: [String: Any]) throws {
    guard let id = recordingId else { throw logError("Missing recording identity") }
    var row = extra
    row.merge(["schemaVersion": 1, "recordType": "event", "eventType": type,
      "recordingId": id, "sourceId": "ios-corelocation", "deviceBootId": bootId,
      "occurredAtUtc": iso(now), "occurredMonotonicUs": mono, "lastSequence": sequence - 1]) { _, new in new }
    try append(row)
  }

  private func append(_ row: [String: Any]) throws {
    guard let url = logURL else { throw logError("Missing log path") }
    let data = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    var directory = url.deletingLastPathComponent()
    var values = URLResourceValues(); values.isExcludedFromBackup = true
    try directory.setResourceValues(values)
    if !FileManager.default.fileExists(atPath: url.path) {
      guard FileManager.default.createFile(atPath: url.path, contents: nil,
        attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]) else {
        throw logError("Cannot create recording file")
      }
    }
    let handle = try FileHandle(forWritingTo: url)
    defer { try? handle.close() }
    try handle.seekToEnd()
    try handle.write(contentsOf: data + Data([0x0a]))
    try handle.synchronize()
  }

  // Shared with the telemetry writer so both logs use one sleep-inclusive
  // monotonic time domain; see MonotonicClock in DiagnosticsTelemetry.swift.
  private func monotonicUs() -> Int64 { MonotonicClock.continuousMicroseconds() }
  private func utcMs(_ date: Date) -> Int64 { Int64(date.timeIntervalSince1970 * 1000) }
  private func persistClock() {
    defaults.set(bootId, forKey: "roadscope.bootId")
    defaults.set(bootAnchor, forKey: "roadscope.continuousBootAnchorMs")
  }
  private func iso(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }
  private func logError(_ message: String) -> NSError { NSError(domain: "RoadScope", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
  private func fail(_ message: String) {
    telemetry?.stop(serviceState: "failed", detail: message)
    telemetry = nil
    manager.stopUpdatingLocation()
    segmentStarted = false
    defaults.set(false, forKey: "roadscope.active")
    defaults.set("error", forKey: "roadscope.state")
    defaults.set(message, forKey: "roadscope.error")
  }
  public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    // Temporary loss of a fix is recoverable; keep listening and let sample age
    // drive the UI's stale indication.
    if let locationError = error as? CLError, locationError.code == .locationUnknown { return }
    fail(error.localizedDescription)
  }
}
