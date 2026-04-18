param appName string
param location string
param registryLoginServer string
param registryUsername string
@secure()
param registryPassword string
param identityId string
param identityClientId string
param storageAccountName string
param storageContainerName string
param dbConnectionString string
param googleClientId string
@secure()
param googleClientSecret string
@secure()
param sessionSecret string
@secure()
param jwtSecret string

var envName = '${appName}-env'
var apiAppName = '${appName}-api'
var workerAppName = '${appName}-worker'
// Placeholder image — Container Apps needs something to start; real image pushed by CI later
var placeholderImage = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: envName
  location: location
  properties: {
    zoneRedundant: false
  }
}

var commonEnv = [
  { name: 'NODE_ENV',                    value: 'production' }
  { name: 'DATABASE_URL',                value: dbConnectionString }
  { name: 'AZURE_STORAGE_ACCOUNT_NAME',  value: storageAccountName }
  { name: 'AZURE_STORAGE_CONTAINER_NAME',value: storageContainerName }
  { name: 'AZURE_CLIENT_ID',             value: identityClientId } // for DefaultAzureCredential
  { name: 'SESSION_SECRET',              secretRef: 'session-secret' }
  { name: 'JWT_SECRET',                  secretRef: 'jwt-secret' }
  { name: 'GOOGLE_CLIENT_ID',            value: googleClientId }
  { name: 'GOOGLE_CLIENT_SECRET',        secretRef: 'google-client-secret' }
]

var commonSecrets = [
  { name: 'registry-password',    value: registryPassword }
  { name: 'session-secret',       value: sessionSecret }
  { name: 'jwt-secret',           value: jwtSecret }
  { name: 'google-client-secret', value: googleClientSecret }
]

resource apiApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: apiAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvironment.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'http'
        corsPolicy: {
          allowedOrigins: ['*']
          allowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']
          allowedHeaders: ['*']
          allowCredentials: true
        }
      }
      registries: [
        {
          server: registryLoginServer
          username: registryUsername
          passwordSecretRef: 'registry-password'
        }
      ]
      secrets: commonSecrets
    }
    template: {
      containers: [
        {
          name: 'api'
          image: placeholderImage
          env: commonEnv
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 3
        rules: [
          {
            name: 'http-scaling'
            http: {
              metadata: {
                concurrentRequests: '20'
              }
            }
          }
        ]
      }
    }
  }
}

resource workerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: workerAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvironment.id
    configuration: {
      ingress: null // Worker is internal, no public ingress
      registries: [
        {
          server: registryLoginServer
          username: registryUsername
          passwordSecretRef: 'registry-password'
        }
      ]
      secrets: commonSecrets
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: placeholderImage
          env: union(commonEnv, [
            { name: 'WORKER_MODE', value: 'true' }
          ])
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

output apiUrl string = 'https://${apiApp.properties.configuration.ingress.fqdn}'
output apiAppName string = apiAppName
output workerAppName string = workerAppName
output environmentName string = envName
