# @pmwdigital/ai-guard

Guards calls to the Anthropic API. When the account runs out of credit or the API
key stops working, it blocks further calls for 10 minutes, then lets one call
through to check, and tells your code why AI is unavailable.

It has no runtime dependencies and does not import the Anthropic SDK. TypeScript,
shipped as ESM, for Node 20 or newer.

## Why

A request that fails because the credit balance is gone or the key was revoked
keeps failing until someone fixes the account. Sending more of them achieves
nothing and fills the logs with the same error.

This package recognizes those two failures, remembers them in memory, stops
running your calls, and fails closed: your code gets an `AiUnavailable` error with
a reason it can show (`not_configured`, `billing`, `auth`, `budget` or `disabled`).

## Install

```bash
npm install github:pmwdigital/pmw-ai-guard
```

## Use

Wrap each call in `claudeCall`. The API key is read from `ANTHROPIC_API_KEY`.

```ts
import Anthropic from "@anthropic-ai/sdk";
import { AiUnavailable, claudeCall } from "@pmwdigital/ai-guard";

const client = new Anthropic();

export async function ask(messages: Anthropic.MessageParam[]) {
    try {
        return await claudeCall(() =>
            client.messages.create({ model, max_tokens: 1024, messages }),
        );
    } catch (err) {
        if (err instanceof AiUnavailable) return { unavailable: err.reason };
        throw err;
    }
}
```

`model` is whichever model you use. What `claudeCall` does:

- No key (unset or blank): throws `AiUnavailable` with reason `not_configured`
  and does not run your function.
- Billing error (credit gone) or auth error (invalid key, permission denied):
  throws `AiUnavailable` with reason `billing` or `auth`, and the original error
  is available as `err.cause`. For the next 10 minutes (`AI_PAUSE_MS`) every call
  throws `AiUnavailable` without running your function.
- When the 10 minutes are over, the next call runs as a probe. Other calls made
  while the probe is running still get the reason. If the probe succeeds, the
  pause is cleared. If it fails with another billing or auth error, a new 10
  minutes start. Any other error leaves the state as it was and is rethrown.
- Every other error (overloaded, rate limit, server error, network) is rethrown
  unchanged and starts no pause. The package does not retry.

The probe is a real call from your code. The package never sends a request of its
own.

## Error kinds

`classifyAiError(err)` returns one of five kinds. It reads fields, not classes, so
errors from another copy of the SDK, from a wrapper, or from a test double are
recognized too.

| Kind | Matches |
| --- | --- |
| `billing` | status 402, type `billing_error`, or a message containing "credit balance", "purchase credits" or "Plans & Billing" |
| `auth` | status 401 or 403, type `authentication_error` or `permission_error` |
| `overloaded` | status 529 or 503, type `overloaded_error` |
| `rate_limit` | status 429, type `rate_limit_error` |
| `other` | everything else, including values that are not objects |

A drained balance comes back as a 400 `invalid_request_error`, so that case is
recognized by its message text.

## Availability

```ts
import { aiAvailability } from "@pmwdigital/ai-guard";

const status = await aiAvailability();
```

`status` is `{ configured, available, reason? }`:

| State | Result |
| --- | --- |
| No key | `{ configured: false, available: false, reason: "not_configured" }` |
| Paused after a billing error | `{ configured: true, available: false, reason: "billing" }` |
| Healthy | `{ configured: true, available: true }` |

Once the pause is over, availability reports `available: true` again, so the next
real call can act as the probe.

`aiConfigured()` tells whether a non-blank key is set. `aiBlocked()` is the
synchronous check: it returns `"not_configured"`, `"billing"`, `"auth"` or `null`,
which is enough to skip background work.

## Budget and kill switch

The package does not know how you meter spend. Pass an async callback that returns
`"budget"`, `"disabled"` or `null`, to both `aiAvailability` and `claudeCall`:

```ts
import { aiAvailability, claudeCall, type AiPolicyCheck } from "@pmwdigital/ai-guard";

const policy: AiPolicyCheck = async () => {
    if (await killSwitchIsOn()) return "disabled";
    if ((await spentTodayUsd()) >= dailyCapUsd) return "budget";
    return null;
};

const status = await aiAvailability(policy);
const message = await claudeCall(
    () => client.messages.create({ model, max_tokens: 1024, messages }),
    policy,
);
```

- The callback runs on every availability check and before every guarded call, so
  keep it cheap or cache the answer.
- `disabled` wins over everything else, then a missing key or an active pause,
  then `budget`.
- If the callback throws, your function is not called and the error propagates.

## Without the wrapper

When you cannot wrap the call, for example a stream you forward to a client, check
`aiBlocked()` before sending and report the outcome yourself:

- `noteAiFailure(err)` returns the error kind and starts the pause for billing and
  auth errors.
- `noteAiSuccess()` clears the pause.
- `resetAiGuard()` clears all state. Use it in tests, or right after you top up
  credit instead of waiting for the pause to end.

## Limits

- State lives in memory in one process, in module scope, so each installed copy of
  the package has its own. Several servers, workers or serverless instances each
  learn about a failure on their own first failing call, and a restart forgets it.
  Sharing the pause between instances needs a shared store, which this package does
  not provide.
- A 403 `permission_error` counts as an auth failure and pauses every call, even
  if the key only lacks access to one model.
- The 400 credit case is recognized by message text. If that wording changes, such
  errors are classified as `other` and no pause starts.
- The pause length is fixed at 10 minutes.
- The key check reads `process.env.ANTHROPIC_API_KEY`, so it needs Node.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

## License

MIT
