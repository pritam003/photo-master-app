param appName string
param location string

// ACR names: 5-50 chars, alphanumeric only
var registryName = take(toLower(replace('${appName}acr', '-', '')), 50)

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: true // needed for Container Apps to pull images
    publicNetworkAccess: 'Enabled'
    zoneRedundancy: 'Disabled'
  }
}

output registryName string = registry.name
output loginServer string = registry.properties.loginServer
output adminUsername string = registry.listCredentials().username
@secure()
output adminPassword string = registry.listCredentials().passwords[0].value
