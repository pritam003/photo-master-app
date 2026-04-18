# APhoto — Deployment Plan

## meta
- status: approved
- version: 1.0.0
- updated: 2026-04-18

## Goal
One-click "Deploy to Azure" button on the login page. New user clicks → Azure portal opens with pre-filled template → fills 2 inputs (appName + location) → creates all resources in one resource group → app is live.

## Resources (subscription-scope deployment, single RG)

| # | Resource | Name pattern | SKU | Est. cost |
|---|---|---|---|---|
| 1 | Resource Group | `{appName}-rg` | — | Free |
| 2 | Container Registry | `{appName}acr` | Basic | ~$5/mo |
| 3 | PostgreSQL Flexible Server | `{appName}-db` | B1ms | ~$13/mo |
| 4 | Storage Account + container | `{appName}store` | LRS Standard | ~$0 |
| 5 | Container Apps Environment | `{appName}-env` | Consumption | ~$0 idle |
| 6 | Container App — API | `{appName}-api` | Consumption | ~$0 idle |
| 7 | Container App — Worker | `{appName}-worker` | Consumption | ~$0 idle |
| 8 | Static Web App | `{appName}-web` | Free | Free |
| 9 | Computer Vision | `{appName}-vision` | F0 free | Free |
| 10 | Managed Identity | `{appName}-id` | — | Free |

## Parameters
- `appName` (string, default "myphotos") — drives all resource names
- `location` (string) — Azure region slug (e.g. "eastus")
- `googleClientId` (string, optional, default "")
- `googleClientSecret` (string, optional, secure, default "")

## Auth strategy
- Microsoft Entra app registration: created automatically via `deploymentScripts` resource
- Google OAuth: user fills after deploy (manual, unavoidable)
- Container Apps use Managed Identity for Blob Storage access (no storage key in env vars)

## Deployment type
- Subscription-scope (`targetScope = 'subscription'`) so the template creates the RG itself
- Compiled to `infra/azuredeploy.json` (ARM JSON) — referenced by the portal button URL

## Files to create
- `infra/main.bicep`
- `infra/modules/database.bicep`
- `infra/modules/storage.bicep`
- `infra/modules/registry.bicep`
- `infra/modules/containerApps.bicep`
- `infra/modules/staticWebApp.bicep`
- `infra/modules/vision.bicep`
- `infra/modules/identity.bicep`
- `infra/azuredeploy.json` (compiled)

## Steps
- [x] Plan created
- [ ] Bicep modules
- [ ] main.bicep
- [ ] Compile to ARM JSON
- [ ] login.tsx deploy modal
- [ ] README badge
- [ ] Commit + push
