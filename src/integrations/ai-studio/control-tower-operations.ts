/**
 * Map AWS Control Tower GetLandingZoneOperation observations to blueprint
 * workflow states. The caller must obtain this result from the cloud-read
 * broker, not an AI-produced claim.
 */
export type ControlTowerOperationObservation = {
  operationIdentifier: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  operationType: string;
  evidenceSource: "AWS_CONTROL_TOWER";
  startedAt?: string;
  endedAt?: string;
};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function parseControlTowerOperation(
  operationIdentifier: string,
  response: unknown
): ControlTowerOperationObservation {
  if(!UUID.test(operationIdentifier))throw new Error("CONTROL_TOWER_OPERATION_ID_INVALID");
  if(!response || typeof response!=="object" || Array.isArray(response))
    throw new Error("CONTROL_TOWER_RESPONSE_INVALID");
  const details=(response as Record<string,unknown>).operationDetails;
  if(!details || typeof details!=="object" || Array.isArray(details))
    throw new Error("CONTROL_TOWER_OPERATION_DETAILS_MISSING");
  const x=details as Record<string,unknown>;
  const status=x.status;
  if(!["IN_PROGRESS","SUCCEEDED","FAILED"].includes(String(status)))
    throw new Error("CONTROL_TOWER_OPERATION_STATUS_UNKNOWN");
  if(typeof x.operationType!=="string" || !x.operationType || x.operationType.length>40)
    throw new Error("CONTROL_TOWER_OPERATION_TYPE_UNKNOWN");
  const observation:ControlTowerOperationObservation={
    operationIdentifier,
    status:status as ControlTowerOperationObservation["status"],
    operationType:x.operationType,
    evidenceSource:"AWS_CONTROL_TOWER"
  };
  if(typeof x.startTime==="string" && Number.isFinite(Date.parse(x.startTime)))
    observation.startedAt=x.startTime;
  if(typeof x.endTime==="string" && Number.isFinite(Date.parse(x.endTime)))
    observation.endedAt=x.endTime;
  return observation;
}
export function controlTowerBlueprintProgress(
  observation: ControlTowerOperationObservation
): "EXECUTING" | "VERIFYING" | "FAILED" {
  if(observation.status==="IN_PROGRESS")return "EXECUTING";
  if(observation.status==="FAILED")return "FAILED";
  // AWS operation SUCCEEDED alone does not prove final landing-zone resources
  // and guardrails are healthy: a separate read-back/verify step is mandatory.
  return "VERIFYING";
}
