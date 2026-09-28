# Automation observers

本目录给 ZCode / 人工审计查看长期运维观察器 Prompt。

## 与业务 Prompt 的关系

- 六个生产业务 Prompt 的 canonical source：`../prompts/`
- 六个生产任务的实际安装版本、task id、hash：`../control/production.json`
- 本目录：长期运维观察器快照
- 本目录**不参与** `build_prompts.py` 编译，也不会自动发布到 ChatGPT Automation。

当前保留：
- `collector-issue-acceptance.md`：Collector Issue 验收收口，逐字镜像当前已知保存 Prompt。
- `production-health.md`：生产任务健康检查，当前规则语义快照。

刻意不收录：
- 已停用的历史重复观察器；
- 一次性诊断任务；
- 已失效的旧 Prompt 副本。

原则：**业务源看 prompts，生产安装态看 control/production.json，运维观察规则看 observers。**
