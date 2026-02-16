
# Design Specification: Paper Hearts

---

## 1. Design Philosophy

**Warm, focused, elegant — with touches of fun.**

Paper Hearts should feel like opening a beautiful notebook, not using an app. The interface recedes so the words take center stage. Delight lives in small moments — a subtle animation when the veil lifts, the warmth of the color palette, the satisfying weight of a handwritten-style heading — not in flashy UI chrome.

**Principles:**
- **Intimate, not social.** This is a two-person space. No feeds, no likes, no public anything. The design should feel private and personal.
- **Calm, not minimal.** Minimalism can feel cold. Paper Hearts should feel warm and textured — like a love letter, not a spreadsheet.
- **Focused, not busy.** One action per screen. Write. Read. That's it. No sidebars, no tabs, no feature overload.
- **Playful, not childish.** Moments of delight (animations, micro-interactions) should feel elegant, like a wink — not a cartoon.

---

## 2. Color Palette

### Primary Palette

| Name | Hex | Usage |
| --- | --- | --- |
| **Parchment** | `#FDF6EC` | Background — warm off-white, like aged paper |
| **Ink** | `#2C2C2C` | Primary text — soft black, easier on the eyes than pure black |
| **Blush** | `#E8A0BF` | Accents — buttons, highlights, the "heart" of the brand |
| **Rose** | `#C76B9B` | Active states, pressed buttons, links |
| **Dusty Mauve** | `#9B7B8E` | Secondary text, timestamps, metadata |

### Supporting Palette

| Name | Hex | Usage |
| --- | --- | --- |
| **Veiled** | `#D4C5B9` | Veil state — muted, desaturated, like frosted glass over the entry |
| **Revealed** | `#F9E8D0` | Revealed entry background — a warmer glow than the base parchment |
| **Soft Red** | `#D94F4F` | Errors, destructive actions (rare) |
| **Sage** | `#8FB39A` | Success confirmations, sync complete |

### Dark Mode (V2+)

Not in V1. The warm parchment palette is the core identity. Dark mode will be considered for V2 with a "candlelight" variant — deep warm browns rather than cold grays.

---

## 3. Typography

| Role | Font | Weight | Size |
| --- | --- | --- | --- |
| **Headings / Day Labels** | **Playfair Display** | 700 | 24–32px |
| **Body / Entry Text** | **Source Serif 4** | 400 | 17px (mobile-optimized reading size) |
| **UI Labels / Buttons** | **Inter** | 500 | 14–16px |
| **Timestamps / Metadata** | **Inter** | 400 | 12px |

- Playfair Display for headings adds a literary, elegant feel — like a book title page.
- Source Serif 4 for diary entries is highly readable and feels personal without being a script font.
- Inter for UI elements is clean and functional — it stays out of the way.
- All fonts loaded via Google Fonts, subset to Latin to keep payload small.

---

## 4. Layout & Spacing

- **Max content width:** 480px, centered. Diary entries shouldn't stretch across wide screens.
- **Horizontal padding:** 24px on mobile.
- **Vertical rhythm:** 8px base unit. All spacing is multiples of 8.
- **Entry cards:** No hard borders. Separated by generous whitespace (32px) and a subtle horizontal rule (1px, `Veiled` color).
- **Safe areas:** Respect iOS safe area insets (notch, home indicator).

---

## 5. Screen Designs

### 5.1 Compose Screen

- Full-screen text area on the warm Parchment background.
- Placeholder text in Dusty Mauve: *"What's on your heart today?"*
- No toolbar, no formatting options (V1 is plain text / markdown).
- Submit button: Blush background, white text, rounded (12px radius), bottom-anchored with 16px padding from the keyboard.
- Subtle character count in Dusty Mauve at bottom-right (no hard limit, just awareness).
- After submit: button transitions to Sage with a soft checkmark, then navigates to the Today screen.

### 5.2 Veiled State (Today / Yesterday)

- The user's own entry is displayed in full on a Revealed card.
- The partner's entry area shows a **frosted veil**: a blurred rectangle in the Veiled color with a small heart icon (Blush) and the text *"Waiting for [partner]..."* in Dusty Mauve.
- Subtle breathing animation on the heart icon (slow scale pulse, 3s cycle). This is the "touch of fun."

### 5.3 Revealed State

- Both entries appear stacked vertically.
- Each entry sits on a Revealed background card with soft rounded corners (16px).
- Author label above each entry in Dusty Mauve (e.g. "You" / partner name).
- A one-time **reveal animation** plays when both entries become visible:
    - The veil dissolves (opacity fade, 600ms ease-out).
    - The partner's entry slides up gently (translateY 12px → 0, 400ms).
    - A small scatter of heart particles (3–5 tiny Blush hearts, 800ms, fade out). Subtle — not confetti. This is the "fun."

### 5.4 Archive

- Vertical list of days, most recent first.
- Each row: day label (Playfair Display, e.g. "Monday, Feb 15") + a small status indicator:
    - Two filled hearts (Blush): both wrote.
    - One filled heart + one outline: only one wrote.
    - Two outline hearts (Veiled): neither wrote.
- Tapping a day opens the revealed-entry view (same component as 5.3).

### 5.5 Initial Kiss (Onboarding)

- Warm, full-screen flow. Parchment background.
- Step 1: *"Start your diary"* — large Playfair heading. Generates keys silently in background.
- Step 2 (Initiator): QR code displayed in a soft Blush-bordered frame. Text: *"Show this to your person."*
- Step 2 (Follower): Camera viewfinder with rounded corners. Text: *"Scan your partner's code."*
- Step 3: Success screen — two hearts connecting animation (simple, 1s). Text: *"You're linked."*
- Transition to Compose.

### 5.6 Install Prompt

- **Soft banner (days 1–2):** Bottom sheet in Revealed color. Blush heart icon. *"Install Paper Hearts to keep your diary safe."* Dismiss button in Dusty Mauve, install button in Blush.
- **Blocking prompt (after day 2):** Full-screen overlay on Parchment. Playfair heading: *"One more step."* Body text explains browser storage risk in plain language. Platform-specific install instructions with illustrated steps. Single Blush CTA button.

### 5.7 Settings

- Simple list layout on Parchment.
- Items: Change passphrase, Re-add partner, About, Version info.
- No toggle switches or complex UI in V1.

---

## 6. Iconography

- Minimal icon set. Line-style, 1.5px stroke, rounded caps.
- Icons in Ink color by default, Blush when active/selected.
- Core icons: heart (filled + outline), lock, pencil (compose), clock (archive), gear (settings), checkmark.
- No icon library — custom SVGs to keep bundle small and style consistent.

---

## 7. Motion & Animation

| Interaction | Animation | Duration | Easing |
| --- | --- | --- | --- |
| Veil breathing (heart pulse) | Scale 1.0 → 1.08 → 1.0 | 3s loop | ease-in-out |
| Veil lift / reveal | Opacity 1 → 0 | 600ms | ease-out |
| Entry appear | translateY 12px → 0, opacity 0 → 1 | 400ms | ease-out |
| Heart particles (reveal) | Scale up + fade out + drift upward | 800ms | ease-out |
| Button press | Scale 0.97, background darken 5% | 120ms | ease-out |
| Screen transition | Fade crossfade | 250ms | ease-in-out |

- All animations respect `prefers-reduced-motion`. If enabled, replace with instant transitions.
- No animation should block user interaction.

---

## 8. Responsive Behavior

- **Mobile-first.** Designed for 375px–428px viewport (iPhone SE → iPhone Pro Max / typical Android).
- **Tablet/Desktop (V1):** Content stays centered at 480px max-width. Parchment background fills the remaining space. Functional but not optimized.
- **Tablet (V2):** Wider content area (640px max-width), larger typography scale, and a more spacious writing experience suited to landscape/tablet use. A dedicated tablet layout is a V2 priority.
- **Orientation:** Portrait only in V1. Landscape is not blocked but not optimized.

---

## 9. Accessibility

- **Contrast ratios:** Ink on Parchment meets WCAG AA (ratio ~13:1). Dusty Mauve on Parchment meets AA for large text (ratio ~4.6:1).
- **Touch targets:** Minimum 44x44px for all interactive elements (Apple HIG / WCAG).
- **Focus indicators:** Blush outline (2px) on keyboard focus for all interactive elements.
- **Screen readers:** All icons have aria-labels. Veil state announces "Waiting for partner's entry" rather than showing blurred content.
- **Reduced motion:** Respected via `prefers-reduced-motion` media query.
