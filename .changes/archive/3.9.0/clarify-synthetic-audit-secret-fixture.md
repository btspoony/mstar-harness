---
category: Testing
packages: root, dsh
---

- Generated the synthetic audit password before interpolating the test document, preserving random secret-detection coverage while preventing a source scanner from mistaking the nested expression for a hardcoded credential.

<!-- CN -->
- 在插入测试文档前生成合成 audit 密码，保留随机值的秘密检测覆盖，并避免源码扫描器将嵌套表达式误判为硬编码凭据。
