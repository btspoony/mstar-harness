---
category: Fixed
packages: dsh
---

- **Milestone create draft no longer leaks across projects.** The panel's create form keyed its draft under the bare string `create`, so text typed in one project's create form re-seeded every other project's form when the operator switched projects. Drafts are now keyed by the identity the form was opened over — the project, plus the create slot or milestone id — so each project's form keeps exactly its own typed text across a read refresh or a revision conflict.

<!-- CN -->
- **里程碑创建草稿不再跨项目串扰。** 面板的创建表单此前以裸字符串 `create` 作为草稿键，在一个项目的创建表单中输入的文字会在切换项目后重新填充另一个项目的表单。草稿现在按表单打开时所属的身份（项目 + 创建槽位或里程碑 id）键控，各项目的表单在读取刷新或版本冲突后只保留自己输入的内容。
