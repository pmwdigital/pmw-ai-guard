import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    AI_PAUSE_MS,
    AiUnavailable,
    aiAvailability,
    aiBlocked,
    aiConfigured,
    claudeCall,
    classifyAiError,
    noteAiFailure,
    noteAiSuccess,
    resetAiGuard,
    type AiPolicyCheck,
} from "./index.js";

const CREDIT =
    "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";

const body = (type: string, message: string) => ({ type: "error", error: { type, message } });

const apiError = (status: number, type: string, message: string) =>
    Object.assign(new Error(`${status} ${JSON.stringify(body(type, message))}`), {
        status,
        type,
        error: body(type, message),
    });

const creditError = () => apiError(400, "invalid_request_error", CREDIT);

const failWith = (err: unknown) => (): Promise<never> => Promise.reject(err);

const answer = (reason: "budget" | "disabled" | null): AiPolicyCheck => async () => reason;

const withKey = () => vi.stubEnv("ANTHROPIC_API_KEY", "test-key");

const startClock = () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T09:00:00Z"));
};

beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    resetAiGuard();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

describe("classifyAiError", () => {
    it("reads credit exhaustion from a 400 message, a billing_error type and a 402 status", () => {
        expect(classifyAiError(creditError())).toBe("billing");
        expect(classifyAiError(apiError(400, "billing_error", "Billing issue"))).toBe("billing");
        expect(classifyAiError({ status: 402, message: "payment required" })).toBe("billing");
        expect(classifyAiError(new Error(`400 ${CREDIT}`))).toBe("billing");
        expect(classifyAiError(apiError(400, "invalid_request_error", "max_tokens: too large"))).toBe("other");
    });

    it("reads the type from the response body when the error has no top-level type", () => {
        expect(classifyAiError({ status: 400, error: body("billing_error", "Billing issue") })).toBe("billing");
        expect(classifyAiError({ error: body("authentication_error", "invalid x-api-key") })).toBe("auth");
        expect(classifyAiError({ error: { type: "rate_limit_error", message: "slow down" } })).toBe("rate_limit");
    });

    it("maps 401 and 403 to auth, 529 and 503 to overloaded, 429 to rate_limit, the rest to other", () => {
        expect(classifyAiError(apiError(401, "authentication_error", "invalid x-api-key"))).toBe("auth");
        expect(classifyAiError(apiError(403, "permission_error", "not allowed"))).toBe("auth");
        expect(classifyAiError(apiError(529, "overloaded_error", "Overloaded"))).toBe("overloaded");
        expect(classifyAiError(apiError(503, "api_error", "unavailable"))).toBe("overloaded");
        expect(classifyAiError(apiError(429, "rate_limit_error", "slow down"))).toBe("rate_limit");
        expect(classifyAiError(apiError(500, "api_error", "boom"))).toBe("other");
        expect(classifyAiError(new Error("network down"))).toBe("other");
    });

    it("treats values that are not error objects as other", () => {
        expect(classifyAiError(null)).toBe("other");
        expect(classifyAiError(undefined)).toBe("other");
        expect(classifyAiError("boom")).toBe("other");
        expect(classifyAiError(402)).toBe("other");
    });
});

describe("AiUnavailable", () => {
    it("is an Error with a stable name, message and reason", () => {
        const err = new AiUnavailable("budget");
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe("AiUnavailable");
        expect(err.message).toBe("ai_unavailable:budget");
        expect(err.reason).toBe("budget");
    });
});

describe("claudeCall without a key", () => {
    it("never calls the function and reports not_configured", async () => {
        const fn = vi.fn(async () => "x");
        await expect(claudeCall(fn)).rejects.toMatchObject({ reason: "not_configured" });
        expect(fn).not.toHaveBeenCalled();
        expect(aiConfigured()).toBe(false);
        expect(aiBlocked()).toBe("not_configured");
        await expect(aiAvailability()).resolves.toEqual({
            configured: false,
            available: false,
            reason: "not_configured",
        });
    });

    it("counts a blank key as missing", () => {
        vi.stubEnv("ANTHROPIC_API_KEY", "   ");
        expect(aiConfigured()).toBe(false);
    });
});

describe("claudeCall with a key", () => {
    it("returns the result of a healthy call", async () => {
        withKey();
        expect(await claudeCall(async () => "reply")).toBe("reply");
        expect(aiConfigured()).toBe(true);
        expect(aiBlocked()).toBeNull();
        await expect(aiAvailability()).resolves.toEqual({ configured: true, available: true });
    });

    it("pauses after a billing error, lets one probe through when the window ends, and reopens on success", async () => {
        withKey();
        startClock();
        const original = creditError();
        const err = (await claudeCall(failWith(original)).catch((e: unknown) => e)) as AiUnavailable;
        expect(err).toBeInstanceOf(AiUnavailable);
        expect(err.reason).toBe("billing");
        expect(err.cause).toBe(original);
        await expect(aiAvailability()).resolves.toEqual({ configured: true, available: false, reason: "billing" });

        const fn = vi.fn(async () => "reply");
        vi.setSystemTime(Date.now() + AI_PAUSE_MS - 1);
        await expect(claudeCall(fn)).rejects.toMatchObject({ reason: "billing" });
        expect(fn).not.toHaveBeenCalled();

        vi.setSystemTime(Date.now() + 1);
        expect((await aiAvailability()).available).toBe(true);
        let release!: (value: string) => void;
        const probe = claudeCall(() => new Promise<string>((resolve) => (release = resolve)));
        await expect(claudeCall(fn)).rejects.toMatchObject({ reason: "billing" });
        expect(fn).not.toHaveBeenCalled();
        release("done");
        expect(await probe).toBe("done");
        await expect(aiAvailability()).resolves.toEqual({ configured: true, available: true });
        expect(await claudeCall(fn)).toBe("reply");
    });

    it("restarts the window when the probe hits another billing error, and keeps probing after a transient one", async () => {
        withKey();
        startClock();
        await claudeCall(failWith(creditError())).catch(() => undefined);

        vi.setSystemTime(Date.now() + AI_PAUSE_MS + 1);
        await expect(claudeCall(failWith(creditError()))).rejects.toMatchObject({ reason: "billing" });
        expect(aiBlocked()).toBe("billing");

        vi.setSystemTime(Date.now() + AI_PAUSE_MS + 1);
        const busy = apiError(529, "overloaded_error", "Overloaded");
        await expect(claudeCall(failWith(busy))).rejects.toBe(busy);
        expect(aiBlocked()).toBeNull();
    });

    it("pauses after an authentication error and reports auth", async () => {
        withKey();
        const original = apiError(401, "authentication_error", "invalid x-api-key");
        const err = (await claudeCall(failWith(original)).catch((e: unknown) => e)) as AiUnavailable;
        expect(err.reason).toBe("auth");
        expect(err.cause).toBe(original);
        expect(aiBlocked()).toBe("auth");
        const fn = vi.fn(async () => "x");
        await expect(claudeCall(fn)).rejects.toMatchObject({ reason: "auth" });
        expect(fn).not.toHaveBeenCalled();
    });

    it("rethrows other errors unchanged and does not pause", async () => {
        withKey();
        for (const original of [
            apiError(500, "api_error", "boom"),
            apiError(529, "overloaded_error", "Overloaded"),
            apiError(429, "rate_limit_error", "slow down"),
            new Error("network down"),
        ]) {
            await expect(claudeCall(failWith(original))).rejects.toBe(original);
            expect(aiBlocked()).toBeNull();
        }
    });
});

describe("policy callback", () => {
    it("adds budget and disabled to the availability report", async () => {
        withKey();
        await expect(aiAvailability(answer("budget"))).resolves.toEqual({
            configured: true,
            available: false,
            reason: "budget",
        });
        await expect(aiAvailability(answer("disabled"))).resolves.toEqual({
            configured: true,
            available: false,
            reason: "disabled",
        });
        await expect(aiAvailability(answer(null))).resolves.toEqual({ configured: true, available: true });
    });

    it("ranks disabled first, then a missing key or pause, then budget", async () => {
        await expect(aiAvailability(answer("disabled"))).resolves.toMatchObject({
            configured: false,
            reason: "disabled",
        });
        await expect(aiAvailability(answer("budget"))).resolves.toMatchObject({ reason: "not_configured" });
        withKey();
        noteAiFailure(creditError());
        await expect(aiAvailability(answer("budget"))).resolves.toMatchObject({ reason: "billing" });
        await expect(aiAvailability(answer("disabled"))).resolves.toMatchObject({ reason: "disabled" });
    });

    it("stops claudeCall with the callback's reason before the function runs", async () => {
        withKey();
        const fn = vi.fn(async () => "x");
        await expect(claudeCall(fn, answer("budget"))).rejects.toMatchObject({ reason: "budget" });
        await expect(claudeCall(fn, answer("disabled"))).rejects.toMatchObject({ reason: "disabled" });
        expect(fn).not.toHaveBeenCalled();
        expect(await claudeCall(fn, answer(null))).toBe("x");
    });

    it("keeps the probe for a later call when the callback refuses after the window ends", async () => {
        withKey();
        startClock();
        await claudeCall(failWith(creditError())).catch(() => undefined);
        vi.setSystemTime(Date.now() + AI_PAUSE_MS);
        const fn = vi.fn(async () => "x");
        await expect(claudeCall(fn, answer("budget"))).rejects.toMatchObject({ reason: "budget" });
        expect(fn).not.toHaveBeenCalled();
        expect(await claudeCall(fn)).toBe("x");
        expect(aiBlocked()).toBeNull();
    });

    it("runs one probe when two calls wait on the callback at the same time", async () => {
        withKey();
        startClock();
        await claudeCall(failWith(creditError())).catch(() => undefined);
        vi.setSystemTime(Date.now() + AI_PAUSE_MS);
        const fn = vi.fn(async () => "x");
        const results = await Promise.allSettled([claudeCall(fn, answer(null)), claudeCall(fn, answer(null))]);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    });

    it("fails closed when the callback rejects: the function is not called and the error propagates", async () => {
        withKey();
        const boom = new Error("store unavailable");
        const broken: AiPolicyCheck = async () => {
            throw boom;
        };
        const fn = vi.fn(async () => "x");
        await expect(claudeCall(fn, broken)).rejects.toBe(boom);
        await expect(aiAvailability(broken)).rejects.toBe(boom);
        expect(fn).not.toHaveBeenCalled();
    });
});

describe("recording outcomes without the wrapper", () => {
    it("pauses on billing and auth only, and clears on success", () => {
        withKey();
        expect(noteAiFailure(apiError(529, "overloaded_error", "Overloaded"))).toBe("overloaded");
        expect(noteAiFailure(apiError(500, "api_error", "boom"))).toBe("other");
        expect(aiBlocked()).toBeNull();
        expect(noteAiFailure(creditError())).toBe("billing");
        expect(aiBlocked()).toBe("billing");
        expect(noteAiFailure(apiError(403, "permission_error", "not allowed"))).toBe("auth");
        expect(aiBlocked()).toBe("auth");
        noteAiSuccess();
        expect(aiBlocked()).toBeNull();
    });

    it("resetAiGuard clears the pause", () => {
        withKey();
        noteAiFailure(creditError());
        expect(aiBlocked()).toBe("billing");
        resetAiGuard();
        expect(aiBlocked()).toBeNull();
    });
});
