import { useFlag } from "@nanoflags/sdk/react";

export function Checkout({ user }: { user: User }) {
  const other = useFlag("search-ranking", "relevance-v2");
  return (
    <section data-ranking={other}>
      <Summary />
      <LegacyNotice />
      <Footer compact={false} />
    </section>
  );
}

export function Inline() {
  return <Old />;
}

export function Banner() {
  return <B1 />;
}
