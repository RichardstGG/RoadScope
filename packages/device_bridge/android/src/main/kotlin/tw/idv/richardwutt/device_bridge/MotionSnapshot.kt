package tw.idv.richardwutt.device_bridge

/** UI-only freshness guard. Never fabricates a new measurement or modifies
 * persisted estimates; uses native boot-inclusive time, not a Flutter timer. */
internal fun motionSnapshotAt(value: Map<String, Any?>, now: Long): Map<String, Any?> {
    val measured = value["leanMeasurementUs"] as? Long ?: return value
    return if (measured > now || now - measured > 500_000)
        value + mapOf("leanAngleDeg" to null, "leanState" to "unavailable", "leanFlags" to listOf("input_stale"))
    else value
}
