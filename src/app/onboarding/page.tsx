import { Page, PageHeader, Callout } from "@/components/ui";
import { worldMode } from "@/lib/world";
import { chainConfigured, operator, MIN_DEPOSIT_TINYBARS } from "@/lib/config";
import { formatAmount } from "@/lib/money";
import { OnboardingFlow } from "./flow";

export const dynamic = "force-dynamic";
export const metadata = { title: "Become a seller" };

export default function OnboardingPage() {
  return (
    <Page className="max-w-[860px]">
      <PageHeader
        eyebrow="Supply side"
        title="Become a seller"
        description="Two gates stand between an account and a live listing: proof of a distinct human, and money at risk. Both are enforced by the API, not just this page."
      />

      <div className="mb-5">
        <Callout tone="neutral" title="Why the gates exist">
          Without verification, one person lists fifty services and disappears
          with the payments. Without a deposit, a bad response costs the seller
          nothing. Selfie Check answers the first; the refundable deposit
          answers the second.
        </Callout>
      </div>

      <OnboardingFlow
        worldMode={worldMode()}
        chainConfigured={chainConfigured}
        treasury={operator.accountId || "not configured"}
        minimumDeposit={MIN_DEPOSIT_TINYBARS.toString()}
        minimumLabel={`${formatAmount(MIN_DEPOSIT_TINYBARS)} ℏ`}
      />
    </Page>
  );
}
