package tw.idv.richardwutt.device_bridge

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry

class DeviceBridgePlugin : FlutterPlugin, MethodChannel.MethodCallHandler, ActivityAware,
    PluginRegistry.RequestPermissionsResultListener {
    private lateinit var channel: MethodChannel
    private lateinit var context: Context
    private var activity: Activity? = null
    private var activityBinding: ActivityPluginBinding? = null
    private var pendingStart: MethodChannel.Result? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, "device_bridge")
        channel.setMethodCallHandler(this)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "start" -> start(result)
            "stop" -> {
                context.startService(Intent(context, LocationRecorderService::class.java).apply {
                    action = LocationRecorderService.ACTION_STOP
                })
                result.success(null)
            }
            "status" -> result.success(LocationRecorderService.status(context))
            "readLog" -> readFile(result) { done -> LocationRecorderService.readLog(context, done) }
            // Diagnostics telemetry is a separate file, never merged into the log.
            "readTelemetry" -> readFile(result) { done ->
                LocationRecorderService.readTelemetry(context, done)
            }
            else -> result.notImplemented()
        }
    }

    private fun readFile(result: MethodChannel.Result,
        read: ((String?, Exception?) -> Unit) -> Unit) {
        read { content, error ->
            Handler(Looper.getMainLooper()).post {
                if (error == null) result.success(content)
                else result.error("read_failed", error.message, null)
            }
        }
    }

    private fun start(result: MethodChannel.Result) {
        if (pendingStart != null) {
            result.error("busy", "Location permission request in progress", null)
            return
        }
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED) {
            val current = activity
            if (current == null) {
                result.error("no_activity", "Open the app to grant location permission", null)
                return
            }
            pendingStart = result
            current.requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION), 8042)
            return
        }
        launch(result)
    }

    private fun launch(result: MethodChannel.Result) {
        try {
            // Must be invoked while the activity is foreground on Android 14+,
            // which is also why an attached activity means the app is
            // foreground right now; the service cannot work that out later.
            ContextCompat.startForegroundService(context,
                Intent(context, LocationRecorderService::class.java).putExtra(
                    LocationRecorderService.EXTRA_INITIAL_FOREGROUND, activity != null))
            result.success(null)
        } catch (error: Exception) {
            result.error("start_failed", error.message, null)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>,
        grantResults: IntArray): Boolean {
        if (requestCode != 8042) return false
        val result = pendingStart ?: return false
        pendingStart = null
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)
            == PackageManager.PERMISSION_GRANTED) launch(result)
        else result.error("permission_denied", "Precise location permission is required", null)
        return true
    }

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activityBinding = binding
        activity = binding.activity
        binding.addRequestPermissionsResultListener(this)
    }

    override fun onDetachedFromActivityForConfigChanges() = detachActivity()
    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) = onAttachedToActivity(binding)
    override fun onDetachedFromActivity() = detachActivity()

    private fun detachActivity() {
        activityBinding?.removeRequestPermissionsResultListener(this)
        activityBinding = null
        activity = null
        pendingStart?.error("activity_detached", "Retry location permission from the open app", null)
        pendingStart = null
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel.setMethodCallHandler(null)
    }
}
