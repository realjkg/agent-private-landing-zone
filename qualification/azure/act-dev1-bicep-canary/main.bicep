// ACT-DEV-1 Azure Bicep canary: one empty virtual network (no subnets) in the existing pilot resource group.
// The Bicep engine passes no parameter values, so every parameter has a default. The values below are EXAMPLE values:
// the operator sets name, the owner tag and the three unit tags for each run (see README.md). location defaults to the
// pilot group's region. The tags are written as literal strings: the engine refuses tags (or address prefixes) that are an
// ARM expression, so what is deployed is exactly the sealed text (TEMPLATE_VALUE_NOT_LITERAL).

@description('The canary virtual network name. Use a new name for each run.')
@minLength(22)
@maxLength(64)
param name string = 'vnet-alz-act-dev-1-canary-01'

@description('The region. Defaults to the existing pilot resource group\'s region.')
param location string = resourceGroup().location

resource canary 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: name
  location: location
  tags: {
    environment: 'DEV'
    'managed-by': 'sovereign-alz'
    purpose: 'act-dev-1'
    owner: 'REPLACE-WITH-APPROVED-OWNER'
    // Exactly the three unit tags that ./alz apply prepare prints.
    'alz-build': 'REPLACE-WITH-PREPARE-OUTPUT'
    'alz-managed-by': 'REPLACE-WITH-PREPARE-OUTPUT'
    'alz-unit': 'REPLACE-WITH-PREPARE-OUTPUT'
  }
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.250.0.0/24'
      ]
    }
  }
}
