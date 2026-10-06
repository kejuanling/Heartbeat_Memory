# 前端设计 Skill 库

服务器上的可复用前端设计 skill 集。**做任何前端 / UI / 设计稿 / 网页相关任务前，先看这里。**

## 使用方式

1. 按任务类型选 skill（见下表）
2. Read 对应目录的 `SKILL.md`
3. 按其指导动手；skill 只是指导文本，不负责执行

## 清单

| Skill | 来源 | 何时用 | 依赖 |
| --- | --- | --- | --- |
| frontend-design | Anthropic 官方（anthropics/skills） | 新建界面 / 改视觉 / 设计稿：设计方向、避免 AI 味、排版配色原则 | 无（纯文本） |
| web-design-guidelines | Vercel（vercel-labs/agent-skills） | UI 审计 / 可访问性 / 按最佳实践检查界面 | 需联网拉取规则源（SKILL.md 内有 URL） |

## 维护规则

- 真身在服务器；增改 skill 需用户同意，改完 `git add` 具体文件单独提交（绝不 `-A`）
- 新增 skill 时更新本 README 清单
- 本库与 `工作流/01_全局操作规范.md`「前端设计 Skill 库」小节联动
