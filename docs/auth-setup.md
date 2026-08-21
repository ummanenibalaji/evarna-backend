# Making Google and Apple sign-in work end to end

Email sign-in already works with no setup at all — codes are written to the
server log when `RESEND_API_KEY` is unset. Google and Apple need external
configuration before they will do anything, and this is that list.

**Current state:** the backend verifies both providers' identity tokens already
and needs nothing but environment variables. The frontend calls a stub that
returns `null`, so both buttons currently say "isn't wired up yet — continue
with email". Everything below is the work between here and those buttons
working.

---

## Before anything else: settle the bundle identifier

The app is still `app.whisper.companion` in `app.json` — `bundleIdentifier` on
iOS and `package` on Android.

Both of the flows below bind credentials to that identifier: Apple's App ID
carries it, and Google's iOS and Android OAuth clients carry it. Changing it
afterwards means recreating every credential, and the identifier is permanent
once a store record exists.

**Settle the final identifier first.** Everything below assumes it is done.

---

## Google

### 1. Google Cloud Console

Create a project, then **APIs & Services → OAuth consent screen**:

- User type **External**
- App name, support email, developer contact
- Scopes: `openid`, `email`, `profile` — nothing more. Extra scopes trigger a
  verification review we do not need.
- While in Testing mode only listed test users can sign in, which is fine
  until launch. Publishing is a separate step and can take days if the consent
  screen asks for anything sensitive — it will not, with those three scopes.

### 2. Create three OAuth client IDs

Under **Credentials → Create credentials → OAuth client ID**:

| Type | Needs | Why |
|---|---|---|
| **Web application** | nothing | Not optional. The React Native library uses the *web* client id to request an ID token, and that id ends up in the token's `aud`. Skipping it is the single most common reason this flow silently fails. |
| **iOS** | the bundle identifier | Produces the reversed-client-id URL scheme iOS needs. |
| **Android** | package name + SHA-1 fingerprint | See the fingerprint note below. |

**The Android SHA-1 catches people out.** It must be the fingerprint of the key
that actually signs the build. A debug build, an EAS internal build and a Play
Store build can all be signed with *different* keys, and each fingerprint has to
be registered or sign-in fails on that build only — which reads like a code bug
and is not one.

```bash
eas credentials          # pick Android → keystore → view fingerprint
```

Register the debug fingerprint, the EAS build fingerprint, and — once Play App
Signing is set up — the fingerprint Google shows in the Play Console.

### 3. Backend environment

```bash
# All three, comma-separated. A native app produces different audiences
# depending on platform and library version; listing all of them means the
# token verifies whichever one it carries.
GOOGLE_CLIENT_IDS=<web-client-id>,<ios-client-id>,<android-client-id>
```

`verifyProviderToken()` in `src/services/auth.service.ts` passes this list as
the accepted audience set. A token whose `aud` is not in the list is rejected
with a deliberately vague "Sign-in failed" — the specific reason goes to the
server log only, because distinguishing "expired" from "wrong audience" helps
an attacker map our configuration.

### 4. Frontend

```bash
npx expo install @react-native-google-signin/google-signin
```

Add the config plugin to `app.json` with the **reversed iOS client id** as the
URL scheme, then replace the stub in `src/navigation/App.tsx`:

```ts
GoogleSignin.configure({
  webClientId: '<web-client-id>',   // this is what puts the right aud in the token
  iosClientId: '<ios-client-id>',
});
const { idToken } = await GoogleSignin.signIn();
```

`idToken` is what `POST /api/v1/auth/google` wants as `id_token`.

This needs a development build. It will not work in Expo Go — the library is a
native module. The project already uses `expo-dev-client`, so this is just
another `eas build --profile development`.

---

## Apple

### 1. Apple Developer Program enrolment

Blocked on the D-U-N-S number if enrolling as an organisation — that is five to
fourteen business days and is on the critical path for the whole launch, not
just for this.

### 2. Enable the capability

**Certificates, Identifiers & Profiles → Identifiers →** your App ID → tick
**Sign in with Apple**. Regenerate provisioning profiles afterwards, or the
build will fail with an entitlement mismatch that does not mention Apple
sign-in anywhere in the error.

### 3. Backend environment

```bash
# For native iOS sign-in the identity token's audience is the BUNDLE ID —
# not a client id, not a Services ID.
APPLE_CLIENT_IDS=app.evarna.companion
```

A Services ID and a signing key are only needed for Apple sign-in on the web or
on Android. We are iOS-native only, so skip both.

### 4. Frontend

```bash
npx expo install expo-apple-authentication
```

Set `expo.ios.usesAppleSignIn: true` in `app.json`, then:

```ts
const credential = await AppleAuthentication.signInAsync({
  requestedScopes: [
    AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
    AppleAuthentication.AppleAuthenticationScope.EMAIL,
  ],
});
// credential.identityToken → POST /api/v1/auth/apple { id_token }
```

Only render the button when `AppleAuthentication.isAvailableAsync()` resolves
true — it is iOS-only, and on Android the button must not appear at all.

### 5. Two Apple behaviours that will look like bugs

**Email arrives once, ever.** Apple returns the email address only on the very
first authorization for a given Apple ID. Every subsequent sign-in — including
after deleting and reinstalling the app — returns `null`. The backend already
handles this: users are matched on the provider's subject claim, never on
email, so a missing address changes nothing. Do not "fix" this by matching on
email; that would let an address change become an account takeover.

To test the first-run path again, revoke the app under **Settings → Apple ID →
Password & Security → Apps Using Apple ID**.

**Relay addresses are real.** Users who choose "Hide My Email" get an
`@privaterelay.appleid.com` address. It is a valid, deliverable address. Never
filter these out.

### 6. This is not optional

App Store Guideline 4.8 requires Sign in with Apple in any app offering another
third-party sign-in. Shipping Google without Apple is a rejection, not a
warning.

---

## Verifying it works

The three checks below prove the chain end to end without a UI.

**1. The backend rejects a bad token** — already covered by `npm run check:auth`,
which asserts forgery, `alg=none`, wrong issuer, wrong audience and expiry.

**2. A real token verifies.** With the app running against a dev build, log the
`idToken` before sending it, then:

```bash
curl -s localhost:3000/api/v1/auth/google \
  -H 'content-type: application/json' \
  -d '{"id_token":"<paste>"}' | jq
```

Expect `{ success: true, data: { token, user_id, onboarding_completed } }`. A
401 means the audience does not match — check the server log, which records the
real reason even though the response does not.

**3. The session token works.**

```bash
curl -s localhost:3000/api/v1/auth/me -H 'authorization: Bearer <token>' | jq
```

---

## Failure modes, and what they actually mean

| Symptom | Cause |
|---|---|
| 401 on `/auth/google`, log says audience mismatch | `GOOGLE_CLIENT_IDS` is missing the id the token carries. Add the web client id — it is usually this. |
| Google sign-in works on iOS, fails on Android | The SHA-1 for that build's signing key is not registered. Different builds, different keys. |
| Google sign-in throws immediately in the app | Running in Expo Go. Needs a development build. |
| Apple build fails with an entitlement error | Capability enabled but provisioning profile not regenerated. |
| Apple sign-in returns no email on the second try | Correct and expected. See above. |
| Everything 401s after a deploy | `JWT_SECRET` changed. That signs every user out — it is the intended lever if it leaks, but it is not something to change casually. |

---

## What is already done

Nothing in this list needs writing — it is all in place and covered by
`npm run check:auth` and `npm run check:routes`:

- Provider token verification against Google's and Apple's published keys,
  with issuer and audience pinned
- Our own 30-day session tokens, and revocation by `token_version` bump
- User creation on first sign-in, matched on the provider subject
- Email one-time codes, including rate limiting and constant-time comparison
- The global auth hook, its six-route public allowlist, and ownership checks on
  every other route
