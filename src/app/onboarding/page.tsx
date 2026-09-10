import { Page, PageHeader, Callout } from "@/components/ui";
import { describeWorld } from "@/lib/world";
import { chainConfigured, operator, MIN_DEPOSIT_TINYBARS } from "@/lib/config";
import { formatAmount } from "@/lib/money";
import { OnboardingFlow } from "./flow";

export const dynamic = "force-dynamic";
export const metadata = { title: "Become a seller" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Sellers and operators need different things from this page.
 *
 * A seller wants to know whether they can verify right now. The operator wants
 * to know which Developer Portal setting is missing — which is debug output,
 * and pointing it at customers is how a product ends up telling strangers to
 * edit a file they will never have access to. `?setup=1` separates the two.
 * Nothing secret hides behind it; it is an audience switch, not a permission.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const world = describeWorld();
  const setupView = "setup" in (await searchParams);

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
          nothing. World ID {world.credential_label} answers the first; the
          refundable deposit answers the second.
        </Callout>
      </div>

      <OnboardingFlow
        setupView={setupView}
        worldMode={world.mode}
        credentialLabel={world.credential_label}
        worldProblem={world.problem}
        chainConfigured={chainConfigured}
        treasury={operator.accountId || "not configured"}
        minimumDeposit={MIN_DEPOSIT_TINYBARS.toString()}
        minimumLabel={`${formatAmount(MIN_DEPOSIT_TINYBARS)} ℏ`}
      />
    </Page>
  );
}
