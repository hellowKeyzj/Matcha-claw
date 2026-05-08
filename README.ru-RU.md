<p align="center">
  <img src="src/assets/logo.svg" width="128" height="128" alt="MatchaClaw Logo" />
</p>

<h1 align="center">MatchaClaw</h1>

<p align="center">
  <strong>Desktop-интерфейс для AI-агентов OpenClaw</strong>
</p>

<p align="center">
  <a href="#обзор">Обзор</a> •
  <a href="#возможности">Возможности</a> •
  <a href="#быстрый-старт">Быстрый старт</a> •
  <a href="#разработка">Разработка</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-MacOS%20%7C%20Windows%20%7C%20Linux-blue" alt="Platform" />
  <img src="https://img.shields.io/badge/electron-40+-47848F?logo=electron" alt="Electron" />
  <img src="https://img.shields.io/badge/react-19-61DAFB?logo=react" alt="React" />
  <a href="https://discord.com/invite/84Kex3GGAh" target="_blank">
  <img src="https://img.shields.io/discord/1399603591471435907?logo=discord&labelColor=%20%235462eb&logoColor=%20%23f5f5f5&color=%20%235462eb" alt="chat on Discord" />
  </a>
  <img src="https://img.shields.io/github/downloads/ValueCell-ai/MatchaClaw/total?color=%23027DEB" alt="Downloads" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License" />
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ja-JP.md">日本語</a> | Русский
</p>

---

## Обзор

**MatchaClaw** превращает возможности OpenClaw в понятный desktop-опыт: чат с агентами, подключение каналов, управление навыками, задачи по расписанию и настройки моделей доступны без CLI.

Русский интерфейс уже доступен в приложении. Если каких-то строк пока не хватает в переводе, они безопасно берутся из текущих ресурсов приложения, поэтому UI остаётся рабочим целиком.

## Возможности

- Чат с OpenClaw-агентами, история сессий, Markdown и LaTeX-формулы через KaTeX
- Каналы сообщений, навыки, задачи по расписанию
- Модели, плагины, безопасность и рабочие пространства субагентов
- Electron desktop-приложение на React 19 + TypeScript

## Быстрый старт

```bash
pnpm run init
pnpm dev
```

Готовые команды для разработки, тестов и сборки описаны в [README.md](README.md).

## Разработка

- Меняйте язык приложения в Setup или Settings
- Фронтенд использует `src/i18n/` как единый источник локализаций
- Для новых ключей перевода добавляйте namespace сразу во все поддерживаемые языки
