# MatchaClaw

MatchaClaw 是本仓库中的桌面应用。它集成 OpenClaw 作为 agent runtime substrate，并在桌面壳内托管本地 runtime 能力。

## Language

**MatchaClaw**:
本仓库中的桌面应用与产品。
_Avoid_: OpenClaw desktop

**OpenClaw**:
MatchaClaw 集成并适配的 agent runtime substrate。
_Avoid_: MatchaClaw runtime

**runtime-host**:
由 MatchaClaw 拥有的本地常驻 runtime process。
_Avoid_: backend service, server

**OpenClaw plugins**:
通过 OpenClaw plugin interface 接入的 plugin packages。
_Avoid_: MatchaClaw packages
