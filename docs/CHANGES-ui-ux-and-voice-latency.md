# Evarna — UI/UX uplift, performance and voice latency

September 2026. This document covers every change made in this round, in both repositories:

| Repo | Branch | What |
|---|---|---|
| `evarna-frontend` | `feat/ui-ux-uplift` | UI/UX audit fixes, new design foundation, every screen rebuilt, smoothness work, Xcode 27 build fixes |
| `evarna-backend` | `feat/voice-latency-and-account-linking` | Voice latency and lost-reply fixes, account linking, Studio delete, onboarding guard, voice preview clips |

---

## 1. Summary

**Voice latency** (caller-side, measured with real LiveKit calls and real audio; time from the end of the caller's sentence to the companion's first sound):

| | Turns | p50 | p95 | Replies with no audio | Talk-over |
|---|---|---|---|---|---|
| Before | 15 | 2683 ms | 3118 ms | 1 of 15 | 0 |
| After | 25 | **2433 ms** | **2855 ms** | **0** | 0 |

Every reply in the final runs was spoken to its last word (Hume's echoed text covered the whole reply, and the audio heard matched the audio generated).

**App quality.** A code audit of the whole app (612 findings, each re-checked by a second reviewer; 523 confirmed) scored it 3.8/10 against ChatGPT Voice, Pi, Calm and Apple's own apps. Accessibility scored lowest, at 2/10. All 84 must-fix items and most polish items are addressed. A second review of the rebuilt code found 70 more defects, and all are fixed. A performance pass then removed the main causes of jank.

---

## 2. How to run

- **Backend:** `npm run dev` (API on :3000) and `npm run voice-worker`, with Redis on :6380 and Ollama running. The `.env` needs `HUME_API_KEY`, and the account needs Hume credits: without credits every reply is silent.
- **App:**
  - **Development build:** `npx expo start --dev-client` with `EXPO_PUBLIC_API_URL=http://<LAN-IP>:3000` in `.env`.
  - **Release build:** build the `Whisper` scheme in Xcode with the Release configuration. The JavaScript is embedded, so no Metro is needed.
  - **Never run `expo prebuild`.** `ios/` holds hand-made fixes for Xcode 27 that prebuild would overwrite.
- **Checks:**
  - frontend: `npm run typecheck` and `npm run check:*` (entitlement, ai-notice, crisis, api-url, voice-call);
  - backend: `npx tsc --noEmit` and `npm run check:*` (voice-tts-ownership, voice-latency, prompt, routes, auth, account-linking, character-guards and others);
  - `npm run voice-e2e -- <wav dir>` measures latency end to end from the caller's side.

---

## 3. App (evarna-frontend)

### 3.1 Build and platform

- **Xcode 27.**
  - Pods are raised to the app's deployment target.
  - The app adopts the UIScene lifecycle: a `SceneDelegate` in `AppDelegate.swift` and a scene manifest in Info.plist. Without these, iOS 27 terminates the app at launch.
  - expo-dev-launcher still gets its window created in the AppDelegate.
- **New native modules:** `react-native-reanimated` 4.1 (with `react-native-worklets`), `react-native-gesture-handler` 2.28, `expo-haptics`, `expo-keep-awake`, `expo-clipboard`, `expo-audio`, `expo-application`, `expo-file-system`.
- **`app.json` now matches what iOS actually builds:**
  - `newArchEnabled: true` (Reanimated 4 needs it);
  - the display name is **Evarna** (was "Whisper");
  - the app opens `evarna://` links;
  - iPhone only (the UI is portrait-phone);
  - the launch screen uses the warm background instead of slate.
- **`metro.config.js`:** inline requires, so a cold start runs only the modules the first screen needs.
- **Release safety:** a release build refuses to ship without a usable `EXPO_PUBLIC_API_URL`. `check:api-url` runs as the EAS post-install hook.

### 3.2 Design foundation (used by every screen)

- **Tokens** (`src/theme/theme.ts`):
  - Muted text colours are raised to at least 4.5:1 contrast.
  - `W.onAccent`: labels on coral or aurora buttons were white at 2.1–3.1:1 and are now dark at 6–9:1.
  - A capped Dynamic Type scale (`TYPE`, 11pt floor), plus `HIT` (44pt), `ELEV`, `Z`, and `MOTION` (durations, easings, springs).
- **Motion** (`src/theme/motion.ts`, `animations.ts`):
  - Reanimated presets that follow the system Reduce Motion setting live.
  - Press feedback runs on the UI thread.
  - Loops pause on screens that are covered or in the background.
  - Haptics fire when a press is released, so a scroll that starts on a button no longer buzzes.
- **Haptics** (`src/lib/haptics.ts`): a small vocabulary of selection, light, medium, heavy, success, warning and error.
- **Accessibility:**
  - `Txt` now scales with Dynamic Type; `allowFontScaling={false}` had disabled it app-wide.
  - `IconButton` and `BackButton` require a label and have 44pt targets.
  - Roles and states on pills, toggles, tabs and buttons.
  - A shared listener for Reduce Motion, Reduce Transparency and the screen reader, and `announce()` for results that arrive asynchronously.
- **Components:**
  - One `Sheet`: drag to dismiss, animated exit, modal to VoiceOver, respects safe areas, returns focus to the control that opened it.
  - `Skeleton`, `EmptyState`, `ErrorState`, `InlineNotice`.
  - A static "frost" glass replaces live blur on cards, tiles, buttons and sheets. It looks the same on the dark background, and live blur remains only on the tab bar.
- **Shell:**
  - An error boundary shows a warm, recoverable screen instead of closing the app.
  - The app is covered in the app switcher. The cover no longer appears over iOS permission prompts or StoreKit sheets.
  - A gesture-handler root wraps the app.

### 3.3 Navigation (`src/navigation/`)

- **Route stack:**
  - Back goes where you came from.
  - Transitions follow direction: a pushed screen slides in, a popped one slides out, tabs cross-fade.
  - Interactive iOS edge-swipe back, and the Android back button.
  - Under Reduce Motion, transitions become cross-fades.
- **Tabs** stay mounted and frozen when hidden, instead of being destroyed and rebuilt on every switch. The other tabs are drawn ahead of time once the app is idle.
- **Sheets** (paywall, out of minutes, recap) are drawn over the screen they came from.
- **Launch and sessions:**
  - Launch waits for the saved sign-in token, so a request sent before it loaded no longer deletes it.
  - Opening the app offline paints from cache instead of signing the user out.
  - Only a real expired session goes to login.
- **Account state:**
  - Profile and minor status load on every sign-in. Before, a minor signing in without relaunching was treated as an adult until the next launch.
  - Sign-out resets all per-account state. Add-companion mode can no longer leak into a new account's onboarding and skip the age check.
  - **Sign-out now signs out this device only.** Account deletion still revokes every device.
- **Other flows:**
  - Every route into a call checks the remaining minutes.
  - Notification permission is asked after Meet.
  - Deleted companions stay deleted.

### 3.4 Screens

- **Voice call** (`src/screens/VoiceCall.tsx`, `useVoiceCall.ts`, `Orb.tsx`):
  - **Orb:**
    - Follows real audio levels from the microphone and from the companion's voice.
    - States blend into each other instead of snapping.
    - The backend's state hint wins over speaker detection, with hysteresis, so the orb no longer flickers to "thinking" at every pause.
  - **During the call:**
    - Live captions from the agent's transcription stream.
    - A speaker and audio-route button, and the screen stays awake.
    - A one-time microphone primer before the first call.
    - A minutes countdown that escalates as it runs down.
  - **After the call:** an end-of-call moment showing duration, with Done or See recap.
  - **Fixes:**
    - Error states disconnect the room, so there is no silent billing.
    - Retry really unmutes.
    - A call without ids fails honestly instead of showing "Connecting…" forever.
    - A full LiveKit reconnect no longer ends the call.
  - **Faster setup:** the session request, audio session and room creation run in parallel and start while the call screen slides in.
- **Chat:**
  - **Performance:**
    - A virtualized, inverted thread.
    - The composer owns its text, so a keystroke redraws only the composer.
    - The streaming reply renders from its own store, so a token redraws one row.
    - Opening a chat takes 2–4 requests instead of about 12 plus up to 1,000 turns.
  - **Real streaming:** `expo/fetch`. React Native's `fetch` has no body stream, so every reply used to arrive in one piece.
  - **Honest failures:**
    - A failed send marks your own message with Retry.
    - An accepted but interrupted send offers Reload instead of a duplicate send.
    - The canned-reply fallback is removed.
    - "Memory saved" appears only for real memory events.
  - **Crisis:** crisis content is shown inline with tappable local resources.
  - **Other:** timestamps and day dividers, Report on long-press, drafts kept per companion, a refetch after background, push or return.
- **Onboarding:**
  - Voice cards play real clips (`assets/voices/<id>.mp3`), and Meet plays a greeting in the chosen voice. It respects the silent switch.
  - The Meet screen appears only once the account has been created.
  - The birthday wheel covers every eligible age (15+), rejects impossible dates, works with VoiceOver, and mounts about 27 rows instead of 147.
- **Home:**
  - The invented line "has been thinking about tomorrow with you" is removed.
  - The check-in follows the time of day, and tapping a mood opens the chat with it.
  - Skeletons, retry and pull-to-refresh.
  - The call button is its own accessible control.
  - Content loads on focus, not while the tab is hidden.
- **Studio:**
  - Characters can be deleted, with a confirmation.
  - Setup shows loading and retry instead of hanging on "Loading setup…".
  - The trait slider no longer jumps to zero, and voice previews play.
  - Session history is paged and the composer is uncontrolled.
- **Settings:**
  - **Paywall on iPhone:** it shows plans without prices or Google Play text until in-app purchase ships on iOS. Terms and Privacy links come from `EXPO_PUBLIC_TERMS_URL` and `EXPO_PUBLIC_PRIVACY_URL`.
  - **Purchases:** a completed purchase is reported as completed even if the follow-up sync fails.
  - **Account deletion:** it warns that store subscriptions must be cancelled first.
  - **Check-ins:** the check-in switch reflects the iOS notification permission.
  - **Memories:** deleting one asks for confirmation.
  - **Profile:** made-up values are gone.
- **Extras:**
  - **Crisis:** the crisis screen lists real, region-aware resources (India first: Tele-MANAS 14416, Vandrevala, AASRA, iCall), with no scripted messages.
  - **Sign-in:** the Apple button is hidden until Sign in with Apple works, and new installs no longer see "Welcome back".
  - **Companion editing:** it opens with current values, saves every field it shows, and names and previews the voice.
- **Sandbox:** back to "coming soon". Every mode, including Intimate 18+, used to answer with canned text and no AI notice.

### 3.5 Smoothness work (the "slow everywhere" report)

The biggest wins, in order:

1. **Chat:** virtualized list, typing and streaming isolated from the rest of the screen, far fewer requests.
2. **No more live blur** behind every card and button. About 10 blurs used to redraw on every frame of scrolling.
3. **Tabs:** they stay built instead of being rebuilt on every switch (`display:none` destroyed their native views).
4. **Re-renders:** the router no longer redraws every mounted screen on each state change. Screens are memoised with stable props, and the toast lives in its own store.
5. **Launch:** LiveKit and WebRTC load on the first call, screens load on first visit, only the used fonts load, and the splash fades straight onto the first screen.
6. **Primitives:** `Txt` caches its styles, icons and atoms are memoised, one shared AppState and accessibility listener, count-ups tick at about 12 per second.
7. **Offscreen work:** animations pause on covered screens.

**Fixed after testing on device:** the tab bar could stay hidden forever after launch. A late "park" callback from its initial fade-out raced the label measurement and hid it again.

---

## 4. Backend (evarna-backend)

### 4.1 Voice latency and lost replies

| Change | Effect | Setting |
|---|---|---|
| **Lost reply fix 1:** a reply ends only once Hume's echoed text reaches the end of what was sent. It used to end on silence, and early audio made it drop the rest of the reply. | 0 silent replies (was 1 in 15) | — |
| **Lost reply fix 2:** `abandonTurn` discards exactly the unspoken text of a cancelled preemptive reply. `cancelTurn`'s `max(1, n)` used to swallow the next real reply. | Proven live in 3 of 3 calls | — |
| **End-of-turn:** the maximum wait when the turn detector isn't sure dropped from 2500 ms to 1500 ms. | Those turns commit about 1 s sooner. A mid-sentence pause of up to 1.4 s stays one turn. | `VOICE_ENDPOINTING_MAX_MS` (default 1500) |
| **First turn:** at call start, the model is primed with this caller's exact first-turn prompt. | First-turn time to first token goes from 1.3–1.7 s to about 0.12 s | — |
| **Model stays loaded** between calls (native Ollama keep-alive after each turn). | No cold model after short idle periods | `LLM_KEEP_ALIVE` (default `30m`) |
| **Memory warm-up** at call start. | No first-turn memory-deadline misses | — |
| **Memories after history** in the voice prompt, so the cached prompt prefix stays reusable. | Later-turn time to first token stays about 0.5 s instead of climbing to 1.2 s | `VOICE_MEMORY_AFTER_HISTORY` (set `false` to revert) |
| **Moderation overlap:** when moderation is slow, the finished reply is synthesised early and its audio held until the verdict. A crisis verdict discards it. | Saves up to the whole moderation wait; with a 1.5 s injected delay, p50 went from 3574 to 2761 ms | `VOICE_PRESYNTHESIS` (set `false` to disable) |
| **Call start:** the plan check runs in parallel with the call-history read (plan refusal still wins). | Slightly faster call start | — |

Also:
- `VOICE_MAX_SENTENCES` (default 3) caps spoken replies.
- `VOICE_VAD_MIN_SILENCE_MS` (default 550) sets the silence that ends a turn.
- The Ollama endpoint receives `max_tokens`, which it honours.
- New safety-parity and adoption checks are in `check:voice-latency`, and lost-reply regressions are in `check:voice-tts-ownership`.
- `npm run voice-e2e` measures end to end from the caller's side.

**Not done:**
- **Starting speech on the first sentence** would save about 0.5 s more. It needs a second flush or a second socket per reply. The one-flush rule exists because multiple flushes lost 49% of the audio, and the test also showed changed prosody and Hume 429s.
- **Where the remaining time goes:** Hume takes about 650 ms to first audio, VAD silence and transport add about 700–850 ms, and moderation holds about 250–400 ms.

### 4.2 Accounts and API

- **Account linking.** Email, Google and Apple sign-ins with the same verified email now resolve to one account (`linked_identities`, unique index).
  - An unverified email never links.
  - `npm run merge:accounts` merges existing duplicates: dry run by default, with a backup, and it refuses production.
  - The `(auth_provider, provider_sub)` unique index is now partial. It could not be built over legacy users that have no provider.
- **Studio:** `DELETE /api/v1/studio/characters/:id` is scoped to the owner and is a soft delete.
- **Safety:** `POST /api/v1/characters/create` refuses accounts that have not finished onboarding (409 `NOT_ONBOARDED`). A client could otherwise create a companion without ever giving a date of birth.
- **Voice clips:** `npm run voice:samples` renders the four voice previews and greetings the app bundles.

---

## 5. New settings

| Where | Name | Default | Purpose |
|---|---|---|---|
| backend | `VOICE_ENDPOINTING_MAX_MS` | 1500 | Longest wait for an uncertain end of turn (2500 restores the old behaviour) |
| backend | `VOICE_VAD_MIN_SILENCE_MS` | 550 | Silence that ends a turn |
| backend | `VOICE_PRESYNTHESIS` | on | Synthesise while a slow moderation check runs |
| backend | `VOICE_MEMORY_AFTER_HISTORY` | on | Put memories after history in voice prompts |
| backend | `LLM_KEEP_ALIVE` | `30m` | How long Ollama keeps the model loaded |
| backend | `VOICE_MAX_SENTENCES` | 3 | Maximum sentences in a spoken reply |
| app | `EXPO_PUBLIC_TERMS_URL`, `EXPO_PUBLIC_PRIVACY_URL` | unset | Paywall legal links (rows hidden while unset) |

---

## 6. Known limitations and follow-ups

- **Sign in with Apple** needs the paid Apple Developer Program. The button stays hidden until then.
- **iOS in-app purchase** is not wired, so the iPhone paywall shows plans without prices.
- **iOS push** needs the `aps-environment` entitlement, which also needs the paid Developer Program. Adding it now would break device signing.
- **Bundle id mismatch:** Xcode builds `app.whisper.companion` while `app.json` says `app.evarna.companion`. This was left alone because changing it affects signing and Google sign-in.
- **Needs review with real users:**
  - The "memories after history" prompt order has not been checked against real returning users' replies.
  - Pre-synthesis has only been proven with an injected moderation delay.
- **Seen but not changed:** cancelled preemptive generations still save a duplicate "Hey." exchange to history, and Ollama runs one prompt-cache slot, so concurrent calls evict each other.

---

## 7. Checking on a device

- **Cold start:** the splash fades straight onto Home and the tab bar is visible.
- **Navigation:** tab switches are instant after the first visit, and edge-swipe back works in chat and settings.
- **Chat:** scrolling a long thread is smooth, the reply streams in, and long-press offers Report.
- **Call:**
  - the orb reacts to both voices;
  - captions, mute and the speaker button work;
  - no reply is silent;
  - the end-of-call screen appears.
- **Accessibility:** turn up Dynamic Type and the text grows; turn on Reduce Motion and transitions cross-fade; VoiceOver reads tabs, buttons and sheets.
