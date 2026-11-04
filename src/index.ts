export type AiErrorKind = "billing" | "auth" | "overloaded" | "rate_limit" | "other";
export type AiOffReason = "not_configured" | "billing" | "auth" | "budget" | "disabled";
export type AiAvailability = { configured: boolean; available: boolean; reason?: AiOffReason };
export type AiPolicyCheck = () => Promise<"budget" | "disabled" | null>;

export const AI_PAUSE_MS = 10 * 60_000;

let paused: { reason: "billing" | "auth"; at: number } | null = null;
let probing = false;

export const aiConfigured = () => !!process.env.ANTHROPIC_API_KEY?.trim();

export class AiUnavailable extends Error {
    constructor(
        readonly reason: AiOffReason,
        options?: ErrorOptions,
    ) {
        super(`ai_unavailable:${reason}`, options);
        this.name = "AiUnavailable";
    }
}

export function classifyAiError(err: unknown): AiErrorKind {
    if (!err || typeof err !== "object") return "other";
    const e = err as { status?: unknown; type?: unknown; error?: unknown; message?: unknown };
    const status = typeof e.status === "number" ? e.status : undefined;
    const body = (e.error ?? {}) as {
        type?: unknown;
        message?: unknown;
        error?: { type?: unknown; message?: unknown };
    };
    const type = String(e.type ?? body.error?.type ?? body.type ?? "");
    const text = [e.message, body.message, body.error?.message]
        .filter((x) => typeof x === "string")
        .join(" ");
    if (
        type === "billing_error" ||
        status === 402 ||
        /credit balance|purchase credits|plans\s*&\s*billing/i.test(text)
    ) {
        return "billing";
    }
    if (status === 401 || status === 403 || type === "authentication_error" || type === "permission_error") {
        return "auth";
    }
    if (status === 529 || status === 503 || type === "overloaded_error") return "overloaded";
    if (status === 429 || type === "rate_limit_error") return "rate_limit";
    return "other";
}

export function aiBlocked(): "not_configured" | "billing" | "auth" | null {
    if (!aiConfigured()) return "not_configured";
    if (!paused) return null;
    if (Date.now() - paused.at < AI_PAUSE_MS || probing) return paused.reason;
    return null;
}

function offReason(denied: "budget" | "disabled" | null): AiOffReason | null {
    return denied === "disabled" ? denied : (aiBlocked() ?? denied);
}

export async function aiAvailability(policy?: AiPolicyCheck): Promise<AiAvailability> {
    const reason = offReason(policy ? await policy() : null);
    const configured = aiConfigured();
    return reason ? { configured, available: false, reason } : { configured, available: true };
}

export function noteAiSuccess(): void {
    paused = null;
}

export function noteAiFailure(err: unknown): AiErrorKind {
    const kind = classifyAiError(err);
    if (kind === "billing" || kind === "auth") paused = { reason: kind, at: Date.now() };
    return kind;
}

export async function claudeCall<T>(fn: () => Promise<T>, policy?: AiPolicyCheck): Promise<T> {
    const off = offReason(policy ? await policy() : null);
    if (off) throw new AiUnavailable(off);
    const probe = paused !== null;
    if (probe) probing = true;
    try {
        const out = await fn();
        noteAiSuccess();
        return out;
    } catch (err) {
        const kind = noteAiFailure(err);
        if (kind === "billing" || kind === "auth") throw new AiUnavailable(kind, { cause: err });
        throw err;
    } finally {
        if (probe) probing = false;
    }
}

export function resetAiGuard(): void {
    paused = null;
    probing = false;
}
