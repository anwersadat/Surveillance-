function escapeCell(value) {
    if (value === null || value === undefined)
        return "";
    const s = value instanceof Date ? value.toISOString() : String(value);
    if (/[",\n\r]/.test(s))
        return `"${s.replace(/"/g, '""')}"`;
    return s;
}
export function toCsv(rows) {
    if (rows.length === 0)
        return "";
    const headers = Object.keys(rows[0]);
    const lines = [headers.join(",")];
    for (const row of rows) {
        lines.push(headers.map((h) => escapeCell(row[h])).join(","));
    }
    return lines.join("\r\n");
}
export function csvResponse(filename, rows) {
    const csv = toCsv(rows);
    return {
        headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`,
        },
        payload: csv,
    };
}
