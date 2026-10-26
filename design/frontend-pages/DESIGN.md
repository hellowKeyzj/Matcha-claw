---
name: MatchaClaw
description: Calm desktop workspace for AI agents, account state, subscriptions, providers, and runtime controls.
colors:
  background: "#F1F1F4"
  foreground: "#1D2025"
  card: "#FFFFFF"
  popover: "#FFFFFF"
  primary: "#000000"
  primary-foreground: "#FFFFFF"
  secondary: "#F3F4F7"
  secondary-foreground: "#1D2025"
  muted: "#EDEFF2"
  muted-foreground: "#60646C"
  accent: "#E8E9EE"
  accent-foreground: "#1D2025"
  destructive: "#EB8E90"
  destructive-foreground: "#1D2025"
  border: "#E0E1E6"
  input: "#D7D7E0"
  ring: "#0D74CE"
  dark-background: "#1A1A1A"
  dark-foreground: "#EDEFF2"
  dark-card: "#1E1E20"
  dark-primary: "#FFFFFF"
  dark-primary-foreground: "#000000"
  dark-secondary: "#27282B"
  dark-muted: "#242628"
  dark-muted-foreground: "#B0B4BA"
  dark-accent: "#2E2F33"
  dark-border: "#363A3F"
  dark-input: "#333333"
  dark-ring: "#2650CF"
typography:
  display:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  label:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "0.75rem"
  md: "0.875rem"
  lg: "1rem"
  card: "1.5rem"
  panel: "2rem"
  pill: "9999px"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "1rem"
  lg: "1.5rem"
  xl: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0.5rem 1rem"
    height: "2.5rem"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0.5rem 1rem"
    height: "2.5rem"
  input-default:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
    height: "2.75rem"
  card-default:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "1.25rem"
    padding: "1.5rem"
  tabs-list:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.pill}"
    padding: "0.25rem"
    height: "2.75rem"
---

# Design System: MatchaClaw

## Overview

**Creative North Star: "The Calm Control Desk"**

MatchaClaw is a restrained desktop product interface: calm neutral surfaces, clear state hierarchy, compact controls, and familiar app-shell patterns. It should feel like a reliable productivity desk where account state, runtime state, subscriptions, providers, agents, plugins, channels, and scheduled tasks are visible without exposing implementation details.

The system is quiet by default. White and cool-gray surfaces carry most screens; black and white primary actions give confidence; blue appears only as focus and operational attention. Login, setup, subscription, and onboarding screens may use deeper atmosphere, but they must still behave like product workflows, not ads.

**Key Characteristics:**
- Compact, task-first density with visible current state.
- Cool neutral canvas, white cards, black primary actions, blue focus.
- Rounded controls that feel tactile without becoming decorative.
- Flat-by-default panels with shadows reserved for hover, popovers, dialogs, and focus.
- Product language hides private upstream implementation names.

## Colors

The palette is a cool operational neutral system with one monochrome action axis and one blue focus accent.

### Primary
- **Command Black**: the primary action surface. Use it for the one dominant action on a screen, never as large decorative fill.
- **Action White**: the text and icon color on Command Black and the light primary foreground.

### Secondary
- **Quiet Control Gray**: the default hover, tab-list, and low-emphasis control surface.
- **System Accent Gray**: selected-muted states, active tab containers, and noncritical highlights.
- **Focus Blue**: keyboard focus, rings, and state attention that needs to be recognizable but not brand-heavy.

### Tertiary
- **Soft Destructive Rose**: destructive and warning-adjacent actions. Pair it with text or icons, not large panels, unless the state is genuinely blocking.

### Neutral
- **Cool Workbench**: the app background and outside-shell canvas.
- **Clean Surface**: cards, popovers, form controls, and content containers.
- **Ink Text**: body text, titles, primary labels, and dense UI copy.
- **Muted Control Text**: secondary labels, metadata, inactive navigation, placeholders, and helper text.
- **Fine Divider**: borders, separators, table strokes, and quiet containment.
- **Field Stroke**: default form control border.
- **Dark Workbench**: dark-mode app background.
- **Dark Surface**: dark-mode cards and popovers.

### Named Rules
**The One Accent Rule.** Blue is a focus and attention token, not a brand wash; it must not compete with primary actions.

**The Product Surface Rule.** App-shell screens stay neutral and task-first; stronger gradients belong only to login, setup, subscription, and onboarding surfaces where the workflow needs visual separation.

## Typography

**Display Font:** Inter with system sans fallbacks.
**Body Font:** Inter with system sans fallbacks.
**Label/Mono Font:** JetBrains Mono for code, paths, command-like values, and technical identifiers.

**Character:** The typography is precise and compact. Hierarchy comes from weight, size, and slight negative tracking, not from decorative typefaces.

### Hierarchy
- **Display** (600, 2.25rem, 1.1): use for login/onboarding hero copy and major page introductions. Keep line length short and balanced.
- **Headline** (600, 1.5rem, 1.2): use for page titles, dialog titles, and high-level empty states.
- **Title** (600, 1.25rem, 1.25): use for cards, sections, panels, and subscription plan names.
- **Body** (400, 0.9375rem, 1.4): use for normal product copy, descriptions, settings, and dense controls. Keep prose at 65 to 75 characters when it becomes paragraph text.
- **Label** (500, 0.875rem, -0.01em): use for buttons, tabs, navigation, form labels, and concise metadata.
- **Micro Label** (600, 0.6875rem to 0.75rem, 0.01em): use for badges and compact status chips only.

### Named Rules
**The No Decoration Type Rule.** Do not introduce display fonts, marketing-style uppercase blocks, or gradient text. Inter is the system voice.

## Elevation

MatchaClaw uses a hybrid of tonal layering and restrained elevation. Most panels are flat with borders and background contrast. Shadows appear only when a surface floats above the app: buttons on hover, dropdowns, dialogs, modal overlays, and focus states.

### Shadow Vocabulary
- **Whisper Shadow**: low tactile lift for primary buttons, active tabs, selected account cards, and small floating states.
- **Elevated Shadow**: popovers, dropdown menus, and surfaces that must visually clear the app shell.
- **Focus Shadow**: keyboard focus reinforcement paired with the blue ring.
- **Modal Shadow**: large dialogs can use stronger native shadow depth because they block interaction underneath.

### Named Rules
**The Flat Rest Rule.** Resting product surfaces are bordered and tonal, not shadowed; if every card casts a shadow, the hierarchy has failed.

## Components

### Buttons
- **Shape:** pill radius for all action buttons.
- **Primary:** black surface with white text, medium label weight, 2.5rem default height, compact horizontal padding, and subtle lift.
- **Hover / Focus:** hover deepens shadow and slightly softens the black; focus uses a blue ring and focus shadow.
- **Secondary / Ghost:** secondary uses a quiet gray fill and border; ghost is transparent with muted text until hover.

### Chips
- **Style:** pill badges with 11px text, semibold weight, compact horizontal padding, and a thin border when not filled.
- **State:** success and warning chips use soft tinted fills; default chips should not dominate the screen.

### Cards / Containers
- **Corner Style:** softly rounded containers, 1.25rem for cards and 1.5rem to 2rem for larger panels.
- **Background:** white or dark surface against the app workbench background.
- **Shadow Strategy:** no shadow at rest unless the surface is floating.
- **Border:** fine neutral border is the main containment mechanism.
- **Internal Padding:** 1.5rem for normal cards; smaller controls use 0.5rem to 1rem.

### Inputs / Fields
- **Style:** 2.75rem height, white or dark surface, interactive radius, clear border, 15px text, and readable placeholder contrast.
- **Focus:** border shifts to Focus Blue with a soft focus shadow.
- **Error / Disabled:** disabled controls lower opacity; errors use destructive color with clear text, not color alone.

### Navigation
- **Style:** side navigation is compact, muted at rest, and rounded on hover or active state. Active destinations need visible text weight, foreground color, and a quiet background.
- **Account Trigger:** default state is borderless and transparent; only hover or open state gets background, border, and shadow.
- **Dropdowns:** render through a portal with a floating card, rounded corners, border, and elevated shadow.

### Tabs and Dialogs
- **Tabs:** pill tab list on Quiet Control Gray, active tab on Clean Surface with Whisper Shadow.
- **Dialogs:** centered, fixed-size product modals with a dark overlay, clear title row, and internal scroll regions. Billing and subscription flows must feel like account management, not checkout advertising.

## Do's and Don'ts

### Do:
- **Do** keep the app shell calm: cool background, white content surface, fine border, and compact controls.
- **Do** reserve Command Black for the dominant action and Focus Blue for focus or operational attention.
- **Do** show state through text, icon, weight, border, and background together; never rely on color alone.
- **Do** use the existing rounded vocabulary: pill for actions, 0.875rem for inputs, 1.25rem to 2rem for panels.
- **Do** use portals for dropdowns and modal surfaces so they never clip inside scroll containers.
- **Do** keep account, billing, and subscription copy in Matcha product language.

### Don't:
- **Don't** make MatchaClaw look like a SaaS marketing site inside the product.
- **Don't** use decorative glassmorphism, heavy gradients, novelty controls, oversized hero metrics, vague cloud buzzwords, or private upstream implementation names.
- **Don't** let modals, account cards, or billing flows feel like ads.
- **Don't** make the product feel CLI-first, server-admin-first, or like a raw wrapper around backend endpoints.
- **Don't** use gradient text, side-stripe borders, bounce motion, dense nested cards, or repeated identical card grids.
- **Don't** add new visual language for one screen when existing buttons, inputs, tabs, cards, badges, and dropdowns already cover the job.
