package tw.idv.richardwutt.device_bridge

/**
 * Observable device and app state at one instant, for post-hoc diagnosis only.
 *
 * Deliberately carries no position data: this is not part of
 * `contracts/location-log/v1` and must never be read as evidence that
 * background collection is stable.
 *
 * `null` means "the platform did not give us a value". Enum-valued fields
 * cannot be null, so they carry an explicit `unknown` member instead; the two
 * cases get different flag suffixes (`*_unavailable` vs `*_unknown`) so a
 * reader never has to guess which one happened.
 */
internal data class TelemetrySnapshot(
    val batteryPercent: Int? = null,
    val batteryCharging: Boolean? = null,
    val batteryPowerSource: String = POWER_SOURCE_UNKNOWN,
    val powerSaveMode: Boolean? = null,
    val screenInteractive: Boolean? = null,
    val keyguardLocked: Boolean? = null,
    val protectedDataAvailable: Boolean? = null,
    val screenStateSource: String = SCREEN_SOURCE_ANDROID,
    val appLifecycle: String = LIFECYCLE_UNKNOWN,
    val locationServiceState: String = SERVICE_UNKNOWN,
    val locationServiceDetail: String? = null,
    val processRestartCount: Int = 0,
    val resumeReason: String? = null,
) {
    companion object {
        const val POWER_SOURCE_UNKNOWN = "unknown"
        const val LIFECYCLE_UNKNOWN = "unknown"
        const val SERVICE_UNKNOWN = "unknown"

        /**
         * Android exposes `PowerManager.isInteractive()` and
         * `KeyguardManager.isKeyguardLocked()`. Neither is a "user looked at a
         * locked screen" event, so the record names the two APIs instead of
         * claiming a lock event.
         */
        const val SCREEN_SOURCE_ANDROID = "android_power_manager_interactive_and_keyguard_locked"
    }

    /** Field names whose value differs from [other]; used for `reasons`. */
    fun changesFrom(other: TelemetrySnapshot): List<String> = buildList {
        if (batteryPercent != other.batteryPercent) add("battery_percent")
        if (batteryCharging != other.batteryCharging) add("battery_charging")
        if (batteryPowerSource != other.batteryPowerSource) add("battery_power_source")
        if (powerSaveMode != other.powerSaveMode) add("power_save_mode")
        if (screenInteractive != other.screenInteractive) add("screen_interactive")
        if (keyguardLocked != other.keyguardLocked) add("keyguard_locked")
        if (protectedDataAvailable != other.protectedDataAvailable) add("protected_data_available")
        if (appLifecycle != other.appLifecycle) add("app_lifecycle")
        if (locationServiceState != other.locationServiceState) add("location_service_state")
        if (locationServiceDetail != other.locationServiceDetail) add("location_service_detail")
        if (processRestartCount != other.processRestartCount) add("process_restart_count")
        if (resumeReason != other.resumeReason) add("resume_reason")
    }
}
