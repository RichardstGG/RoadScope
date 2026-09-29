import CoreLocation
import Flutter
import Foundation

public class DeviceBridgePlugin: NSObject, FlutterPlugin, CLLocationManagerDelegate {
  private let manager = CLLocationManager()
  private let defaults = UserDefaults.standard
  private var sequence = 0
  private var recordingId: String? {
    defaults.string(forKey: "roadscope.recordingId")
  }
  private var logURL: URL? {
    guard let id = recordingId else { return nil }
    let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("recordings", isDirectory: true)
    return directory.appendingPathComponent("\(id).ndjson")
  }

  public static func register(with registrar: FlutterPluginRegistrar) {
    let channel = FlutterMethodChannel(name: "device_bridge", binaryMessenger: registrar.messenger())
    let instance = DeviceBridgePlugin()
    registrar.addMethodCallDelegate(instance, channel: channel)
  }

  override init() {
    super.init()
    manager.delegate = self
    manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
    manager.distanceFilter = kCLDistanceFilterNone
    if defaults.bool(forKey: "roadscope.active") {
      restoreSequence()
      activateIfAuthorized()
    }
  }

  public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "start":
      if !defaults.bool(forKey: "roadscope.active") {
        defaults.set(UUID().uuidString, forKey: "roadscope.recordingId")
        defaults.set(true, forKey: "roadscope.active")
        defaults.set("waiting_permission", forKey: "roadscope.state")
        sequence = 0
      }
      if CLLocationManager.locationServicesEnabled() {
        manager.requestAlwaysAuthorization()
        activateIfAuthorized()
        result(nil)
      } else {
        setError("Location services are disabled")
        result(FlutterError(code: "location_disabled", message: "Enable Location Services", details: nil))
      }
    case "stop":
      manager.stopUpdatingLocation()
      manager.allowsBackgroundLocationUpdates = false
      defaults.set(false, forKey: "roadscope.active")
      defaults.set("idle", forKey: "roadscope.state")
      result(nil)
    case "status":
      result([
        "state": defaults.string(forKey: "roadscope.state") ?? "idle",
        "recordingId": (recordingId as Any?) ?? NSNull(),
        "logPath": (logURL?.path as Any?) ?? NSNull(),
        "error": (defaults.string(forKey: "roadscope.error") as Any?) ?? NSNull(),
      ])
    case "readLog":
      if let url = logURL, FileManager.default.fileExists(atPath: url.path) {
        result((try? String(contentsOf: url, encoding: .utf8)) ?? "")
      } else {
        result("")
      }
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    activateIfAuthorized()
  }

  private func activateIfAuthorized() {
    guard defaults.bool(forKey: "roadscope.active") else { return }
    switch manager.authorizationStatus {
    case .authorizedAlways, .authorizedWhenInUse:
      // The app starts updates in the foreground; the location background mode
      // permits delivery while this user-started recording remains active.
      manager.allowsBackgroundLocationUpdates = true
      manager.pausesLocationUpdatesAutomatically = false
      manager.startUpdatingLocation()
      defaults.set("recording", forKey: "roadscope.state")
      defaults.removeObject(forKey: "roadscope.error")
    case .denied, .restricted:
      setError("Location permission denied")
    case .notDetermined:
      defaults.set("waiting_permission", forKey: "roadscope.state")
    @unknown default:
      setError("Unknown location authorization state")
    }
  }

  public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard defaults.bool(forKey: "roadscope.active"), let id = recordingId,
      let url = logURL else { return }
    for location in locations {
      let receivedAt = Date()
      let flags: [String] = [
        location.speed < 0 ? "invalid_speed" : nil,
        location.course < 0 ? "invalid_heading" : nil,
        location.horizontalAccuracy < 0 ? "invalid_horizontal_accuracy" : nil,
        location.verticalAccuracy < 0 ? "invalid_altitude" : nil,
        location.speedAccuracy < 0 ? "invalid_speed_accuracy" : nil,
        "measurement_monotonic_unavailable",
      ].compactMap { $0 }
      let sample: [String: Any] = [
        "schemaVersion": 1,
        "recordingId": id,
        "sourceId": "ios-corelocation",
        "sourceType": "phone_gnss",
        "deviceBootId": currentBootId(),
        "sequence": sequence,
        "measuredAtUtc": iso(location.timestamp),
        "receivedAtUtc": iso(receivedAt),
        "measurementMonotonicUs": NSNull(),
        "receivedMonotonicUs": Int(ProcessInfo.processInfo.systemUptime * 1_000_000),
        "latDeg": location.coordinate.latitude,
        "lonDeg": location.coordinate.longitude,
        "altitudeM": location.verticalAccuracy >= 0 ? location.altitude as Any : NSNull(),
        "speedMps": location.speed >= 0 ? location.speed as Any : NSNull(),
        "headingDeg": location.course >= 0 && location.course < 360 ? location.course as Any : NSNull(),
        "horizontalAccuracyM": location.horizontalAccuracy >= 0 ? location.horizontalAccuracy as Any : NSNull(),
        "speedAccuracyMps": location.speedAccuracy >= 0 ? location.speedAccuracy as Any : NSNull(),
        "qualityFlags": flags,
      ]
      do {
        let data = try JSONSerialization.data(withJSONObject: sample, options: [.sortedKeys])
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
          withIntermediateDirectories: true)
        var directory = url.deletingLastPathComponent()
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        try? directory.setResourceValues(resourceValues)
        if !FileManager.default.fileExists(atPath: url.path) {
          FileManager.default.createFile(atPath: url.path, contents: nil,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        }
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: data + Data([0x0a]))
        try handle.synchronize()
        sequence += 1
      } catch {
        setError("Location write failed: \(error.localizedDescription)")
        manager.stopUpdatingLocation()
        return
      }
    }
  }

  public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    setError(error.localizedDescription)
  }

  private func restoreSequence() {
    guard let url = logURL else { return }
    if let data = try? Data(contentsOf: url), !data.isEmpty, data.last != 0x0a {
      let complete = data.lastIndex(of: 0x0a).map { Data(data.prefix(through: $0)) } ?? Data()
      try? complete.write(to: url, options: .atomic)
    }
    guard let text = try? String(contentsOf: url, encoding: .utf8) else { return }
    sequence = text.split(separator: "\n").compactMap { line in
      guard let data = line.data(using: .utf8),
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
      return object["sequence"] as? Int
    }.last.map { $0 + 1 } ?? 0
  }

  private func currentBootId() -> String {
    let anchor = Date().timeIntervalSince1970 - ProcessInfo.processInfo.systemUptime
    if abs(anchor - defaults.double(forKey: "roadscope.bootAnchor")) > 60 ||
      defaults.string(forKey: "roadscope.bootId") == nil {
      defaults.set(anchor, forKey: "roadscope.bootAnchor")
      defaults.set(UUID().uuidString, forKey: "roadscope.bootId")
    }
    return defaults.string(forKey: "roadscope.bootId") ?? "unknown"
  }

  private func iso(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }

  private func setError(_ message: String) {
    defaults.set("error", forKey: "roadscope.state")
    defaults.set(message, forKey: "roadscope.error")
  }
}
