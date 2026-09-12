# CI 说明

- `build.yml` —— 推到 `main` 或提 PR 时跑单元测试;打 `v*` tag 时额外出 macOS / Windows 安装包并建 Release。
- 端到端测试(`npm run test:e2e`、`npm run test:e2e:preorder`)会访问真实的 apple.com.cn,
  **不放进 CI**:既不稳定,也不该让 CI 反复去压人家的站。本地手动跑。

## 发一个版本

```bash
npm version patch      # 或 minor / major
git push --follow-tags
```

## 想要签名的包

默认不签名(见 Release 说明)。要签名:

- **macOS**:仓库 Secrets 里加 `CSC_LINK`(Developer ID 证书的 base64 .p12)和 `CSC_KEY_PASSWORD`,
  再把 `electron-builder.yml` 里 `mac.identity: null` 删掉、`hardenedRuntime` 改成 `true`。
  公证还需要 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`。
- **Windows**:加 `CSC_LINK` / `CSC_KEY_PASSWORD`(代码签名证书)。
