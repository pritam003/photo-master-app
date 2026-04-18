param appName string
param location string

resource computerVision 'Microsoft.CognitiveServices/accounts@2023-05-01' = {
  name: '${appName}-vision'
  location: location
  kind: 'ComputerVision'
  sku: {
    name: 'F0' // Free — 5,000 transactions/month
  }
  properties: {
    publicNetworkAccess: 'Enabled'
    customSubDomainName: '${appName}vision'
  }
}

output endpoint string = computerVision.properties.endpoint
@secure()
output key string = computerVision.listKeys().key1
