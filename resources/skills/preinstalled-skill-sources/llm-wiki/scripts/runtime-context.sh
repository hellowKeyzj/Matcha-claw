#!/bin/bash
# MatchaClaw OpenClaw 运行场景解析：供 llm-wiki 脚本复用

normalize_openclaw_platform() {
  case "${1:-auto}" in
    auto|openclaw|desktop|local|cli|electron)
      printf '%s\n' "openclaw"
      ;;
    *)
      echo "不支持的平台：$1" >&2
      return 1
      ;;
  esac
}

resolve_openclaw_config_dir() {
  if [ -n "${OPENCLAW_CONFIG_DIR:-}" ]; then
    printf '%s\n' "$OPENCLAW_CONFIG_DIR"
  else
    printf '%s\n' "$HOME/.openclaw"
  fi
}

resolve_platform_skill_root() {
  local platform
  local config_dir
  platform="$(normalize_openclaw_platform "${1:-openclaw}")" || return 1

  case "$platform" in
    openclaw)
      if [ -n "${OPENCLAW_SKILLS_DIR:-}" ]; then
        printf '%s\n' "$OPENCLAW_SKILLS_DIR"
      else
        config_dir="$(resolve_openclaw_config_dir)"
        printf '%s\n' "$config_dir/skills"
      fi
      ;;
  esac
}

resolve_skill_dir() {
  local script_dir
  script_dir="$(cd "${1:-.}" && pwd)"
  printf '%s\n' "$(cd "$script_dir/.." && pwd)"
}

resolve_templates_dir() {
  local skill_dir="$1"
  printf '%s\n' "$skill_dir/templates"
}

resolve_deps_dir() {
  local skill_dir="$1"
  printf '%s\n' "$skill_dir/deps"
}

detect_layout_mode() {
  local bundle_root="$1"

  if [ -e "$bundle_root/.git" ]; then
    printf '%s\n' "source_checkout"
    return 0
  fi

  printf '%s\n' "installed_skill"
}

resolve_layout_mode() {
  local bundle_root="$1"
  local override_mode="${2:-}"

  if [ -n "$override_mode" ]; then
    printf '%s\n' "$override_mode"
    return 0
  fi

  detect_layout_mode "$bundle_root"
}

resolve_optional_adapter_root() {
  local bundle_root="$1"
  local skill_root_override="${2:-}"
  local override_mode="${3:-}"
  local layout_mode

  if [ -n "$skill_root_override" ]; then
    printf '%s\n' "$skill_root_override"
    return 0
  fi

  layout_mode="$(resolve_layout_mode "$bundle_root" "$override_mode")"

  case "$layout_mode" in
    source_checkout)
      printf '%s\n' "$bundle_root/deps"
      ;;
    installed_skill|upgrade_target)
      printf '%s\n' "$(dirname "$bundle_root")"
      ;;
    *)
      echo "未知运行模式：$layout_mode" >&2
      return 1
      ;;
  esac
}
