# Product

## Register

product

## Users

MatchaClaw is for non-technical users who want to use AI agents, automations, cloud account features, subscriptions, providers, channels, plugins, and scheduled tasks from a desktop app instead of a terminal. They are often trying to get work done quickly, recover from setup issues, or understand account/runtime state without reading config files.

## Product Purpose

MatchaClaw turns OpenClaw-powered AI agent capability into a local desktop workspace. It should make setup, account login, subscription management, provider configuration, agent chat, task scheduling, channels, skills, plugins, diagnostics, and updates understandable from one interface. Success means users can tell what is running, what needs attention, and what action will happen next without knowing the underlying runtime or upstream service names.

## Brand Personality

Restrained, professional, trustworthy. The interface should feel like a reliable productivity tool: calm surfaces, clear hierarchy, precise states, and familiar controls. It can use stronger visual presence in login, subscription, setup, and onboarding surfaces, but the app shell should stay task-first and avoid decorative spectacle.

## Anti-references

Do not make MatchaClaw look like a SaaS marketing site inside the product. Avoid decorative glassmorphism, heavy gradients, novelty controls, oversized hero metrics, vague cloud buzzwords, and UI that exposes private upstream implementation names. Do not let modals, account cards, or billing flows feel like ads. The product should not feel CLI-first, server-admin-first, or like a raw wrapper around backend endpoints.

## Design Principles

1. Make the current state obvious: logged in or out, licensed or blocked, runtime ready or unavailable, paid plan or no active subscription.
2. Keep standard tool affordances: side navigation, tabs, dialogs, forms, tables, empty states, and dropdowns should behave like a polished desktop app.
3. Hide implementation details from product surfaces: users see Matcha account, billing, subscription, runtime, providers, and agents, not private upstream or transport language.
4. Prefer compact clarity over decoration: use space, type weight, borders, and state color to guide attention.
5. Make recovery actionable: when something fails, show what changed, what can be retried, and where to fix it.

## Accessibility & Inclusion

Target WCAG 2.2 AA for product surfaces. Body text and placeholders must meet contrast requirements, keyboard focus must be visible, dialogs and menus must be navigable by keyboard, motion must respect reduced-motion preferences, and state should not rely on color alone.
