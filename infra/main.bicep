targetScope = 'subscription'

@description('Short name for your app — drives all resource names. Lowercase letters and numbers only, 3-16 chars.')
@minLength(3)
@maxLength(16)
param appName string = 'myphotos'

@description('Azure region to deploy all resources into.')
param location string

@description('Google OAuth Client ID (optional — leave blank to skip Google login).')
param googleClientId string = ''

@description('Google OAuth Client Secret (optional).')
@secure()
param googleClientSecret string = ''

// ── Derived secrets (auto-generated, never exposed as outputs) ────────────
var sessionSecret = uniqueString(subscription().id, appName, 'session')
var jwtSecret     = uniqueString(subscription().id, appName, 'jwt')

// ── Resource Group ────────────────────────────────────────────────────────
resource rg 'Microsoft.Resources/resourceGroups@2023-07-01' = {
  name: '${appName}-rg'
  location: location
}

// ── Managed Identity ─────────────────────────────────────────────────────
module identity 'modules/identity.bicep' = {
  name: 'identity'
  scope: rg
  params: {
    appName: appName
    location: location
  }
}

// ── Storage ───────────────────────────────────────────────────────────────
module storage 'modules/storage.bicep' = {
  name: 'storage'
  scope: rg
  params: {
    appName: appName
    location: location
  }
}

// ── Container Registry ───────────────────────────────────────────────────
module registry 'modules/registry.bicep' = {
  name: 'registry'
  scope: rg
  params: {
    appName: appName
    location: location
  }
}

// ── PostgreSQL ────────────────────────────────────────────────────────────
module database 'modules/database.bicep' = {
  name: 'database'
  scope: rg
  params: {
    appName: appName
    location: location
  }
}

// ── Computer Vision ───────────────────────────────────────────────────────
module vision 'modules/vision.bicep' = {
  name: 'vision'
  scope: rg
  params: {
    appName: appName
    location: location
  }
}

// ── Static Web App ────────────────────────────────────────────────────────
module staticWebApp 'modules/staticWebApp.bicep' = {
  name: 'staticWebApp'
  scope: rg
  params: {
    appName: appName
    location: location
  }
}

// ── Container Apps (API + Worker) ─────────────────────────────────────────
module containerApps 'modules/containerApps.bicep' = {
  name: 'containerApps'
  scope: rg
  params: {
    appName: appName
    location: location
    registryLoginServer: registry.outputs.loginServer
    registryUsername:    registry.outputs.adminUsername
    registryPassword:    registry.outputs.adminPassword
    identityId:          identity.outputs.identityId
    identityClientId:    identity.outputs.identityClientId
    storageAccountName:  storage.outputs.storageAccountName
    storageContainerName:storage.outputs.containerName
    dbConnectionString:  database.outputs.connectionStringTemplate
    googleClientId:      googleClientId
    googleClientSecret:  googleClientSecret
    sessionSecret:       sessionSecret
    jwtSecret:           jwtSecret
  }
}

// ── Outputs ───────────────────────────────────────────────────────────────
@description('URL of the deployed APhoto web app.')
output appUrl string = 'https://${staticWebApp.outputs.defaultHostname}'

@description('API URL — set this as VITE_API_URL when building the frontend.')
output apiUrl string = containerApps.outputs.apiUrl

@description('Resource group name.')
output resourceGroupName string = rg.name

@description('Container Registry login server.')
output registryLoginServer string = registry.outputs.loginServer

@description('API Container App name (for CI updates).')
output apiAppName string = containerApps.outputs.apiAppName

@description('Worker Container App name (for CI updates).')
output workerAppName string = containerApps.outputs.workerAppName

@description('Static Web App deployment token — use in GitHub Actions.')
output swaDeploymentToken string = staticWebApp.outputs.deploymentToken
