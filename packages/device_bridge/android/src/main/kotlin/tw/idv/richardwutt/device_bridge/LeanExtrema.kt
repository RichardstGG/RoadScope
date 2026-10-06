package tw.idv.richardwutt.device_bridge

import kotlin.math.abs

internal data class LeanPeak(val magnitudeDeg: Double, val measurementUs: Long)
internal data class LeanSegment(
    val calibrationId: String,
    val bootId: String,
    val effectiveUs: Long,
    val left: LeanPeak? = null,
    val right: LeanPeak? = null,
)

/** Pure in-memory derived state, not a persistence format. Only estimates
 * accepted by the future fusion quality gate may be passed with valid=true.
 * Maxima use the minimum magnitude in a >=100ms contiguous same-side window:
 * a single spike cannot become a peak. Store the selected sample's timestamp. */
internal class LeanExtrema {
    private val finished = mutableListOf<LeanSegment>()
    private val window = ArrayDeque<Pair<Long, Double>>()
    private var previous: Long? = null
    var current: LeanSegment? = null
        private set
    val segments: List<LeanSegment> get() = finished.toList() + listOfNotNull(current)

    fun calibrate(id: String, bootId: String, effectiveUs: Long) {
        require(id.isNotBlank() && bootId.isNotBlank() && effectiveUs >= 0)
        require(segments.none { it.calibrationId == id })
        current?.let { finished.add(it) }
        current = LeanSegment(id, bootId, effectiveUs)
        previous = null
        window.clear()
    }

    fun add(timeUs: Long, bootId: String, angleDeg: Double?, valid: Boolean) {
        val segment = current ?: return
        val last = previous
        if (bootId != segment.bootId || timeUs < segment.effectiveUs ||
            (last != null && timeUs <= last)) {
            window.clear(); return
        }
        if (last != null && timeUs - last > 100_000) window.clear()
        previous = timeUs
        if (!valid || angleDeg == null || !angleDeg.isFinite() || abs(angleDeg) >= 90) {
            window.clear(); return
        }
        if (angleDeg == 0.0) { window.clear(); return }
        if (window.isNotEmpty() && (window.last().second < 0) != (angleDeg < 0)) window.clear()
        window.addLast(timeUs to angleDeg)
        while (window.size > 1 && timeUs - window.elementAt(1).first >= 100_000) window.removeFirst()
        if (timeUs - window.first().first < 100_000) return
        val sample = window.minBy { abs(it.second) }
        val peak = LeanPeak(abs(sample.second), sample.first)
        current = if (angleDeg < 0) {
            if (peak.magnitudeDeg > (segment.left?.magnitudeDeg ?: -1.0)) segment.copy(left = peak) else segment
        } else {
            if (peak.magnitudeDeg > (segment.right?.magnitudeDeg ?: -1.0)) segment.copy(right = peak) else segment
        }
    }
}
