import { Page, PageHeader, Panel, EmptyState } from "@/components/ui";

export default function Placeholder() {
  return (
    <Page>
      <PageHeader title="docs" />
      <Panel><EmptyState title="Coming in a later module" /></Panel>
    </Page>
  );
}
