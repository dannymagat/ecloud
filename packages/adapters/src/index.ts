export const PACKAGE_NAME = '@ecloud/adapters';

export * from './types.js';
export * from './registry.js';
export {
  createAdapter,
  decl,
  attr,
  fieldTable,
  attributeTable,
  sourced,
  type EvidenceInput,
  type SourcedEvidence,
} from './base.js';
export { SRC as SOURCE_REFS } from './source-refs.js';
export * from './registry/index.js';
export * from './vendor/index.js';
export { capabilities as openwifiHostapdRadiusCapabilities } from './adapters/openwifi-hostapd-radius.js';
export { capabilities as openwifiUspotUamCapabilities } from './adapters/openwifi-uspot-uam.js';
export { capabilities as uspotUpstreamUamCapabilities } from './adapters/uspot-upstream-uam.js';
export { capabilities as coovachilliUamCapabilities } from './adapters/coovachilli-uam.js';
export { capabilities as openwifiConfigCapabilities } from './adapters/openwifi-config.js';
