# QuantPro Automation v3：发布期编译的静态精简 Prompt

Git保存唯一可编辑来源和实际安装版本；Automation保存完整静态执行快照；Collector只提供运行态事实、Research Job和State Gateway。**不在任务运行时下载Prompt/Guidance，不让Collector分发配置。**

## 文件与合同
- `build-config.json`：6个既有任务身份、模式、权限、Guidance清单和完整产物预算。
- `prompts/*.md`：业务正文；`fragments/*.md`：共享执行/来源/状态/表达规则；`modes/*.md`：持仓盘中与盘前收盘各自执行流程。仅发布期组合，最终产物没有include或待解析变量。
- `../automation_guidance`、`../research_guidance`：同一exact SHA的研究经验补充；不得覆盖权限。字段级服务端实现不重复塞进模型指令，模型自己的channel授权和lease终态责任必须保留。
- `build_prompts.py`：标准库确定性编译；UTF-8、LF、一个终止换行；校验完整长度（不是源文件长度）。预算持仓5500、产业4500、公司/政策/融资3500字符。超限报错，不自动截断。
- `promote.py`：公开raw exact-SHA校验与候选产物准备。**PREPARED不是已部署**；只有实际保存全文和受保护设置回读通过后，`--apply`才更新`control/production.json`。
- `verify_deployment.py`：对实际Automation响应逐字节全文比较，检查title/schedule/is_enabled/default_timezone/timing_mode/notifications_enabled/email_enabled完全不变。不能拿更新请求或模型回显hash充当服务回读。
- `_build/`仅本地发布产物，不进Git。控制面只记录实际每registry的production_ref、compiled_prompt_sha256、compiled_prompt_chars、contract_version、源hash与VERIFIED状态。混合版本时top-level content_ref=null，以每项为准。

## 执行发布
先从Automation服务读取原设置，保存`_build/before.json`（真实对象数组或含jawbones的JSON；可含全文供原样回滚）。只更新已有任务prompt字段，绝不改时间/启停/通知，不新增生产任务。

```powershell
# 开发预检：此产物标为WORKTREE_PREVIEW，不得冒充公开exact发布
python -B automation/build_prompts.py --source local --ref <当前40位SHA>
python -B -m unittest discover automation -p "test_*.py"
# 审核后commit/push得到候选内容SHA；生产控制此时仍指向旧版本
python -B automation/build_prompts.py --source git --ref <候选SHA> --out automation/_build/git
python -B automation/promote.py --ref <候选SHA> --out automation/_build/public
```

比较Git和public两份manifest中的完整prompt hash及源hash；均一致才采用`public/update-payloads.json`内的prompt-only更新对象，通过获准的Automation工具逐一发布。将**工具实际返回/重新读取的保存对象**写入`_build/after.json`，不是把候选内容复制为“实际结果”。

```powershell
python -B automation/verify_deployment.py --build-dir automation/_build/public --before automation/_build/before.json --after automation/_build/after.json --receipt automation/_build/readback-receipt.json
python -B automation/promote.py --ref <候选SHA> --apply --before automation/_build/before.json --after automation/_build/after.json
```

随后单独commit/push已验证control及不含秘密的审计回执。内容SHA与控制面提交SHA允许不同，避免编译头部SHA/hash自引用。程序不直接调用Automation私有API、不接收token、不自动部署Worker。公开读取失败不改生产指针；候选缺文件/头部错误/未知模板/旧接口/长度超标，或回读正文/设置漂移均拒绝应用。

## 部分发布与回滚
`--keys <registry...>`可只准备/验证实际切换的任务；其他项production_ref保持原值，不能宣称六项已全切。更新返回不明时先读服务对象，不盲目再次提交。任何失败不自动关闭任务。
回滚优先用保存的原始prompt做prompt-only恢复，再读回全文/原设置；或者使用上一份已验证manifest与其exact版本编译器恢复。v2旧版本以当时发布记录中的完整静态快照/源及Guidance恢复，不用v3规则假造旧hash。回滚需正常授权和留痕，不绕过安全拦截。

## 审核与测试边界
`semantic-preservation.md`记录本次旧→新业务规则落点。测试覆盖六项预算、确定性、身份权限/模式、非法路径/缺指导、超限、全文漂移、受保护设置变化、未经回读不得改指针、部分发布。关键词断言只是回归网，不能替代人工语义审核；本次不写假Evidence，不把编译测试冒充交易日自然运行验收。
