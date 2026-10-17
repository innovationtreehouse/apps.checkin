/**
 * Escape user-controlled values before interpolating them into email HTML,
 * so a name/event like `<img src=x onerror=...>` renders as text, not markup.
 */
export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export type VisitSource = 'SCANNER' | 'WEB' | 'TYPED' | 'LEAD_MARKED' | 'FACILITY_CLOSE' | 'AUTO_CLOSE';

/** Human phrase for how a check-in/out was recorded, e.g. "via badge scan". */
export function sourceLine(source?: VisitSource | null): string {
    const label = source === 'SCANNER' ? 'badge scan'
        : source === 'WEB' || source === 'TYPED' ? 'the web app'
        : source === 'LEAD_MARKED' ? 'a staff attendance mark'
        : source === 'FACILITY_CLOSE' ? 'the building closing'
        // An automatic stamp the member may want to correct, so name it plainly
        // rather than implying it was measured.
        : source === 'AUTO_CLOSE' ? 'the system automatically'
        : null;
    return label ? `<p style="color: #6b7280;">📍 via ${label}</p>` : '';
}

/**
 * Base HTML email layout with consistent branding.
 */
export function baseEmailLayout(content: string): string {
    return `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            ${content}
            <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
            <p style="color: #9ca3af; font-size: 12px; text-align: center;">
                Innovation Treehouse — CheckMeIn
            </p>
        </div>
    `;
}
