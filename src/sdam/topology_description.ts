import { ServerDescription } from './server_description';
import WIRE_CONSTANTS = require('../cmap/wire_protocol/constants');
import { TopologyType, ServerType } from './common';

// contstants related to compatability checks
const MIN_SUPPORTED_SERVER_VERSION = WIRE_CONSTANTS.MIN_SUPPORTED_SERVER_VERSION;
const MAX_SUPPORTED_SERVER_VERSION = WIRE_CONSTANTS.MAX_SUPPORTED_SERVER_VERSION;
const MIN_SUPPORTED_WIRE_VERSION = WIRE_CONSTANTS.MIN_SUPPORTED_WIRE_VERSION;
const MAX_SUPPORTED_WIRE_VERSION = WIRE_CONSTANTS.MAX_SUPPORTED_WIRE_VERSION;

// Representation of a deployment of servers
class TopologyDescription {
  type: any;
  setName: any;
  maxSetVersion: any;
  maxElectionId: any;
  servers: any;
  stale: any;
  compatible: any;
  compatibilityError: any;
  logicalSessionTimeoutMinutes: any;
  heartbeatFrequencyMS: any;
  localThresholdMS: any;
  commonWireVersion: any;
  options: any;

  /**
   * Create a TopologyDescription
   *
   * @param {string} topologyType
   * @param {any} [serverDescriptions] the a map of address to ServerDescription
   * @param {string} [setName]
   * @param {number} [maxSetVersion]
   * @param {ObjectId} [maxElectionId]
   * @param {any} [commonWireVersion]
   * @param {any} [options]
   */
  constructor(
    topologyType: string,
    serverDescriptions?: any,
    setName?: string,
    maxSetVersion?: number,
    maxElectionId?: any,
    commonWireVersion?: any,
    options?: any
  ) {
    options = options || {};

    // TODO: consider assigning all these values to a temporary value `s` which
    //       we use `Object.freeze` on, ensuring the internal state of this type
    //       is immutable.
    this.type = topologyType || TopologyType.Unknown;
    this.setName = setName || null;
    this.maxSetVersion = maxSetVersion || null;
    this.maxElectionId = maxElectionId || null;
    this.servers = serverDescriptions || new Map();
    this.stale = false;
    this.compatible = true;
    this.compatibilityError = null;
    this.logicalSessionTimeoutMinutes = null;
    this.heartbeatFrequencyMS = options.heartbeatFrequencyMS || 0;
    this.localThresholdMS = options.localThresholdMS || 0;
    this.commonWireVersion = commonWireVersion || null;

    // save this locally, but don't display when printing the instance out
    Object.defineProperty(this, 'options', { value: options, enumerable: false });

    // determine server compatibility
    for (const serverDescription of this.servers.values()) {
      if (serverDescription.type === ServerType.Unknown) continue;

      if (serverDescription.minWireVersion > MAX_SUPPORTED_WIRE_VERSION) {
        this.compatible = false;
        this.compatibilityError = `Server at ${serverDescription.address} requires wire version ${serverDescription.minWireVersion}, but this version of the driver only supports up to ${MAX_SUPPORTED_WIRE_VERSION} (MongoDB ${MAX_SUPPORTED_SERVER_VERSION})`;
      }

      if (serverDescription.maxWireVersion < MIN_SUPPORTED_WIRE_VERSION) {
        this.compatible = false;
        this.compatibilityError = `Server at ${serverDescription.address} reports wire version ${serverDescription.maxWireVersion}, but this version of the driver requires at least ${MIN_SUPPORTED_WIRE_VERSION} (MongoDB ${MIN_SUPPORTED_SERVER_VERSION}).`;
        break;
      }
    }

    // Whenever a client updates the TopologyDescription from an ismaster response, it MUST set
    // TopologyDescription.logicalSessionTimeoutMinutes to the smallest logicalSessionTimeoutMinutes
    // value among ServerDescriptions of all data-bearing server types. If any have a null
    // logicalSessionTimeoutMinutes, then TopologyDescription.logicalSessionTimeoutMinutes MUST be
    // set to null.
    const readableServers = Array.from(this.servers.values()).filter((s: any) => s.isReadable);
    this.logicalSessionTimeoutMinutes = readableServers.reduce((result: any, server: any) => {
      if (server.logicalSessionTimeoutMinutes == null) return null;
      if (result == null) return server.logicalSessionTimeoutMinutes;
      return Math.min(result!, server.logicalSessionTimeoutMinutes);
    }, null);
  }

  /**
   * Returns a new TopologyDescription based on the SrvPollingEvent
   *
   * @param {SrvPollingEvent} ev The event
   */
  updateFromSrvPollingEvent(ev: any) {
    const newAddresses = ev.addresses();
    const serverDescriptions = new Map(this.servers);
    for (const server of this.servers) {
      if (newAddresses.has(server[0])) {
        newAddresses.delete(server[0]);
      } else {
        serverDescriptions.delete(server[0]);
      }
    }

    if (serverDescriptions.size === this.servers.size && newAddresses.size === 0) {
      return this;
    }

    for (const address of newAddresses) {
      serverDescriptions.set(address, new ServerDescription(address));
    }

    return new TopologyDescription(
      this.type,
      serverDescriptions,
      this.setName,
      this.maxSetVersion,
      this.maxElectionId,
      this.commonWireVersion,
      this.options
    );
  }

  /**
   * Returns a copy of this description updated with a given ServerDescription
   *
   * @param {ServerDescription} serverDescription
   */
  update(serverDescription: ServerDescription) {
    const address = serverDescription.address;
    // NOTE: there are a number of prime targets for refactoring here
    //       once we support destructuring assignments

    // potentially mutated values
    let topologyType = this.type;
    let setName = this.setName;
    let maxSetVersion = this.maxSetVersion;
    let maxElectionId = this.maxElectionId;
    let commonWireVersion = this.commonWireVersion;

    if (serverDescription.setName && setName && serverDescription.setName !== setName) {
      serverDescription = new ServerDescription(address, null);
    }

    const serverType = serverDescription.type;
    let serverDescriptions = new Map(this.servers);

    // update common wire version
    if (serverDescription.maxWireVersion !== 0) {
      if (commonWireVersion == null) {
        commonWireVersion = serverDescription.maxWireVersion;
      } else {
        commonWireVersion = Math.min(commonWireVersion, serverDescription.maxWireVersion);
      }
    }

    // update the actual server description
    serverDescriptions.set(address, serverDescription);

    if (topologyType === TopologyType.Single) {
      // once we are defined as single, that never changes
      return new TopologyDescription(
        TopologyType.Single,
        serverDescriptions,
        setName,
        maxSetVersion,
        maxElectionId,
        commonWireVersion,
        this.options
      );
    }

    if (topologyType === TopologyType.Unknown) {
      if (serverType === ServerType.Standalone && this.servers.size !== 1) {
        serverDescriptions.delete(address);
      } else {
        topologyType = topologyTypeForServerType(serverType);
      }
    }

    if (topologyType === TopologyType.Sharded) {
      if ([ServerType.Mongos, ServerType.Unknown].indexOf(serverType) === -1) {
        serverDescriptions.delete(address);
      }
    }

    if (topologyType === TopologyType.ReplicaSetNoPrimary) {
      if ([ServerType.Standalone, ServerType.Mongos].indexOf(serverType) >= 0) {
        serverDescriptions.delete(address);
      }

      if (serverType === ServerType.RSPrimary) {
        const result = updateRsFromPrimary(
          serverDescriptions,
          setName,
          serverDescription,
          maxSetVersion,
          maxElectionId
        );

        (topologyType = result[0]),
          (setName = result[1]),
          (maxSetVersion = result[2]),
          (maxElectionId = result[3]);
      } else if (
        [ServerType.RSSecondary, ServerType.RSArbiter, ServerType.RSOther].indexOf(serverType) >= 0
      ) {
        const result = updateRsNoPrimaryFromMember(serverDescriptions, setName, serverDescription);
        (topologyType = result[0]), (setName = result[1]);
      }
    }

    if (topologyType === TopologyType.ReplicaSetWithPrimary) {
      if ([ServerType.Standalone, ServerType.Mongos].indexOf(serverType) >= 0) {
        serverDescriptions.delete(address);
        topologyType = checkHasPrimary(serverDescriptions);
      } else if (serverType === ServerType.RSPrimary) {
        const result = updateRsFromPrimary(
          serverDescriptions,
          setName,
          serverDescription,
          maxSetVersion,
          maxElectionId
        );

        (topologyType = result[0]),
          (setName = result[1]),
          (maxSetVersion = result[2]),
          (maxElectionId = result[3]);
      } else if (
        [ServerType.RSSecondary, ServerType.RSArbiter, ServerType.RSOther].indexOf(serverType) >= 0
      ) {
        topologyType = updateRsWithPrimaryFromMember(
          serverDescriptions,
          setName,
          serverDescription
        );
      } else {
        topologyType = checkHasPrimary(serverDescriptions);
      }
    }

    return new TopologyDescription(
      topologyType,
      serverDescriptions,
      setName,
      maxSetVersion,
      maxElectionId,
      commonWireVersion,
      this.options
    );
  }

  get error() {
    const descriptionsWithError: any = Array.from(this.servers.values()).filter(
      (sd: any) => sd.error
    );
    if (descriptionsWithError.length > 0) {
      return descriptionsWithError[0].error;
    }
    return undefined;
  }

  /**
   * Determines if the topology description has any known servers
   */
  get hasKnownServers() {
    return Array.from(this.servers.values()).some((sd: any) => sd.type !== ServerType.Unknown);
  }

  /**
   * Determines if this topology description has a data-bearing server available.
   */
  get hasDataBearingServers() {
    return Array.from(this.servers.values()).some((sd: any) => sd.isDataBearing);
  }

  /**
   * Determines if the topology has a definition for the provided address
   *
   * @param {string} address
   * @returns {boolean} Whether the topology knows about this server
   */
  hasServer(address: string): boolean {
    return this.servers.has(address);
  }
}

function topologyTypeForServerType(serverType: any) {
  switch (serverType) {
    case ServerType.Standalone:
      return TopologyType.Single;
    case ServerType.Mongos:
      return TopologyType.Sharded;
    case ServerType.RSPrimary:
      return TopologyType.ReplicaSetWithPrimary;
    case ServerType.RSOther:
    case ServerType.RSSecondary:
      return TopologyType.ReplicaSetNoPrimary;
    default:
      return TopologyType.Unknown;
  }
}

function compareObjectId(oid1: any, oid2: any) {
  if (oid1 == null) {
    return -1;
  }

  if (oid2 == null) {
    return 1;
  }

  if (oid1.id instanceof Buffer && oid2.id instanceof Buffer) {
    const oid1Buffer = oid1.id;
    const oid2Buffer = oid2.id;
    return oid1Buffer.compare(oid2Buffer);
  }

  const oid1String = oid1.toString();
  const oid2String = oid2.toString();
  return oid1String.localeCompare(oid2String);
}

function updateRsFromPrimary(
  serverDescriptions: any,
  setName: any,
  serverDescription: any,
  maxSetVersion: any,
  maxElectionId: any
) {
  setName = setName || serverDescription.setName;
  if (setName !== serverDescription.setName) {
    serverDescriptions.delete(serverDescription.address);
    return [checkHasPrimary(serverDescriptions), setName, maxSetVersion, maxElectionId];
  }

  const electionId = serverDescription.electionId ? serverDescription.electionId : null;
  if (serverDescription.setVersion && electionId) {
    if (maxSetVersion && maxElectionId) {
      if (
        maxSetVersion > serverDescription.setVersion ||
        compareObjectId(maxElectionId, electionId) > 0
      ) {
        // this primary is stale, we must remove it
        serverDescriptions.set(
          serverDescription.address,
          new ServerDescription(serverDescription.address)
        );

        return [checkHasPrimary(serverDescriptions), setName, maxSetVersion, maxElectionId];
      }
    }

    maxElectionId = serverDescription.electionId;
  }

  if (
    serverDescription.setVersion != null &&
    (maxSetVersion == null || serverDescription.setVersion > maxSetVersion)
  ) {
    maxSetVersion = serverDescription.setVersion;
  }

  // We've heard from the primary. Is it the same primary as before?
  for (const address of serverDescriptions.keys()) {
    const server = serverDescriptions.get(address);

    if (server.type === ServerType.RSPrimary && server.address !== serverDescription.address) {
      // Reset old primary's type to Unknown.
      serverDescriptions.set(address, new ServerDescription(server.address));

      // There can only be one primary
      break;
    }
  }

  // Discover new hosts from this primary's response.
  serverDescription.allHosts.forEach((address: any) => {
    if (!serverDescriptions.has(address)) {
      serverDescriptions.set(address, new ServerDescription(address));
    }
  });

  // Remove hosts not in the response.
  const currentAddresses = Array.from(serverDescriptions.keys());
  const responseAddresses = serverDescription.allHosts;
  currentAddresses
    .filter((addr: any) => responseAddresses.indexOf(addr) === -1)
    .forEach((address: any) => {
      serverDescriptions.delete(address);
    });

  return [checkHasPrimary(serverDescriptions), setName, maxSetVersion, maxElectionId];
}

function updateRsWithPrimaryFromMember(
  serverDescriptions: any,
  setName: any,
  serverDescription: any
) {
  if (setName == null) {
    throw new TypeError('setName is required');
  }

  if (
    setName !== serverDescription.setName ||
    (serverDescription.me && serverDescription.address !== serverDescription.me)
  ) {
    serverDescriptions.delete(serverDescription.address);
  }

  return checkHasPrimary(serverDescriptions);
}

function updateRsNoPrimaryFromMember(
  serverDescriptions: any,
  setName: any,
  serverDescription: any
) {
  let topologyType = TopologyType.ReplicaSetNoPrimary;

  setName = setName || serverDescription.setName;
  if (setName !== serverDescription.setName) {
    serverDescriptions.delete(serverDescription.address);
    return [topologyType, setName];
  }

  serverDescription.allHosts.forEach((address: any) => {
    if (!serverDescriptions.has(address)) {
      serverDescriptions.set(address, new ServerDescription(address));
    }
  });

  if (serverDescription.me && serverDescription.address !== serverDescription.me) {
    serverDescriptions.delete(serverDescription.address);
  }

  return [topologyType, setName];
}

function checkHasPrimary(serverDescriptions: any) {
  for (const addr of serverDescriptions.keys()) {
    if (serverDescriptions.get(addr).type === ServerType.RSPrimary) {
      return TopologyType.ReplicaSetWithPrimary;
    }
  }

  return TopologyType.ReplicaSetNoPrimary;
}

export { TopologyDescription };
