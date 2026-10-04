package tw.idv.richardwutt.device_bridge

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import java.util.Locale

/**
 * Public Android signals and settings entry points that affect long-running
 * background recording.
 *
 * Vendor autostart switches do not have a stable public API. We therefore
 * identify manufacturers that need an explicit checklist, but never claim we
 * can read or change their private switch.
 */
internal object BackgroundExecutionSupport {
    private val guidedManufacturers = setOf(
        "xiaomi", "redmi", "poco", "oppo", "oneplus", "realme",
        "vivo", "iqoo", "huawei", "honor",
    )

    fun notificationPermissionGranted(context: Context): Boolean =
        Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(
            context, Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED

    fun batteryOptimizationIgnored(context: Context): Boolean? =
        (context.getSystemService(Context.POWER_SERVICE) as? PowerManager)
            ?.isIgnoringBatteryOptimizations(context.packageName)

    fun manufacturer(): String = Build.MANUFACTURER.ifBlank { "unknown" }

    fun recommendsVendorGuidance(manufacturer: String = manufacturer()): Boolean =
        manufacturer.lowercase(Locale.ROOT) in guidedManufacturers

    fun openAppSettings(context: Context) = open(
        context,
        Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:${context.packageName}"),
        ),
    )

    fun openBatteryOptimizationSettings(context: Context) = open(
        context,
        Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
    )

    private fun open(context: Context, intent: Intent) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        check(intent.resolveActivity(context.packageManager) != null) {
            "No Android settings screen can handle ${intent.action}"
        }
        context.startActivity(intent)
    }
}
