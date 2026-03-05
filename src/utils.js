// ─── Haversine Distance Calculation ────────────────────────────────────────
export function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function haversineM(lat1, lon1, lat2, lon2) {
    return haversineKm(lat1, lon1, lat2, lon2) * 1000;
}

// ─── Find N nearest items from a list ──────────────────────────────────────
export function findNearest(lat, lon, items, n = 3) {
    return items
        .map(item => ({
            ...item,
            distance: haversineKm(lat, lon, item.lat, item.lon)
        }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, n);
}

// ─── Hallucination Validator ────────────────────────────────────────────────
export function validateReport(reportText, incident) {
    const warnings = [];

    if (incident.confidence < 85) {
        warnings.push({
            code: 'LOW_CONFIDENCE',
            severity: 'warning',
            msg: `Confidence ${incident.confidence}% is below 85% threshold — sections auto-labelled UNVERIFIED`
        });
    }

    const overconfidentTerms = ['definitely', 'certainly', 'without doubt', 'absolutely', 'guaranteed', 'clearly'];
    const hits = overconfidentTerms.filter(t => reportText.toLowerCase().includes(t));
    if (hits.length) {
        warnings.push({
            code: 'OVERCONFIDENT_LANGUAGE',
            severity: 'warning',
            msg: `Overconfident language detected: "${hits.join('", "')}"`
        });
    }

    const typeKeywords = incident.type.toLowerCase().split(' ');
    const matches = typeKeywords.filter(kw => kw.length > 3 && reportText.toLowerCase().includes(kw));
    if (matches.length === 0) {
        warnings.push({
            code: 'TYPE_MISMATCH',
            severity: 'error',
            msg: `AI report may not accurately describe the declared incident type: "${incident.type}"`
        });
    }

    if (!reportText.toLowerCase().includes('confidence assessment')) {
        warnings.push({
            code: 'MISSING_CONFIDENCE_ASSESSMENT',
            severity: 'error',
            msg: 'Report is missing the required CONFIDENCE ASSESSMENT section'
        });
    }

    return { warnings, passed: warnings.length === 0 };
}

// ─── Format time helpers ────────────────────────────────────────────────────
export function formatTime(date) {
    return new Intl.DateTimeFormat('en-IN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(date);
}

export function formatDateTime(date) {
    return new Intl.DateTimeFormat('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(date);
}

export function formatDateTimeISO(date) {
    return date.toISOString().replace('T', ' ').slice(0, 19) + ' IST';
}
