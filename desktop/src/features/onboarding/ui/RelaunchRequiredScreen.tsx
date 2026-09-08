import { RecoveryScreen } from "./RecoveryScreen";
import { BRAND_NAME } from "@/shared/constants/brand";

export function RelaunchRequiredScreen() {
  return (
    <RecoveryScreen
      testId="relaunch-required"
      title={`Restart ${BRAND_NAME} to finish recovery`}
      body={`Your identity was updated. ${BRAND_NAME} needs to restart so syncing and agents run under it.`}
    />
  );
}
