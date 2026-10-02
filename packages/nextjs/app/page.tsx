import Link from "next/link";
import type { NextPage } from "next";
import { ClockIcon, DocumentCheckIcon, LockClosedIcon } from "@heroicons/react/24/outline";
import { Mechanism } from "~~/components/earmark/Mechanism";
import { ProgramList } from "~~/components/earmark/ProgramList";

const PILLARS = [
  {
    icon: LockClosedIcon,
    service: "Token Service",
    title: "The network enforces the purpose",
    body: "Each program mints its own HTS voucher whose KYC key belongs to the Earmark contract. Only enrolled beneficiaries and approved merchants hold KYC, so a transfer anywhere else is rejected by Hedera itself — not by this app.",
  },
  {
    icon: ClockIcon,
    service: "Schedule Service",
    title: "It settles itself",
    body: "At creation the contract schedules its own settlement through HIP-1215. When the program expires the network pays every merchant, voids leftover vouchers and refunds the funder. No keeper, no cron, no admin.",
  },
  {
    icon: DocumentCheckIcon,
    service: "Consensus Service",
    title: "Every purchase is itemised",
    body: "Funders publish a charter and merchants publish itemised receipts to an HCS topic, each signed by the wallet that wrote it. The hash goes on-chain with the redemption, so a donor can trace a dollar to a bag of rice.",
  },
];

const Home: NextPage = () => {
  return (
    <div className="flex flex-col grow">
      <section className="hedera-gradient dark:bg-none dark:bg-hedera-charcoal text-white px-5 py-16">
        <div className="max-w-5xl mx-auto grid gap-10 md:grid-cols-[minmax(0,1fr)_auto] items-center">
          <div className="flex flex-col gap-6">
            <p className="uppercase tracking-widest text-sm text-white/70 m-0">Policy-bound money on Hedera</p>
            <h1 className="text-4xl sm:text-5xl font-bold leading-tight m-0">Money that knows what it is for.</h1>
            <p className="text-lg text-white/80 max-w-2xl m-0">
              Budgets that carry their own rules: who can receive them, where they can be spent, what proves they were
              spent well, and what happens when time runs out. Earmark doesn&apos;t ask the app to enforce where the
              money goes — it gives that job to the network.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link href="/programs/new" className="btn btn-primary">
                Create a program
              </Link>
              <a href="#how-it-works" className="btn btn-ghost text-white border-white/30">
                How Earmark works
              </a>
            </div>
          </div>
          <Mechanism />
        </div>
      </section>

      <section id="how-it-works" className="px-5 py-12 bg-base-200">
        <div className="max-w-5xl mx-auto grid gap-4 md:grid-cols-3">
          {PILLARS.map(({ icon: Icon, service, title, body }) => (
            <article key={service} className="bg-base-100 rounded-2xl border border-base-300 p-6 flex flex-col gap-3">
              <Icon className="h-7 w-7 text-primary" />
              <p className="text-xs uppercase tracking-wider opacity-60 m-0">{service}</p>
              <h2 className="text-lg font-semibold m-0">{title}</h2>
              <p className="text-sm opacity-80 m-0">{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="programs" className="px-5 py-12">
        <div className="max-w-5xl mx-auto flex flex-col gap-6">
          <div className="flex items-end justify-between gap-4">
            <h2 className="text-2xl font-semibold m-0">Programs</h2>
            <Link href="/programs/new" className="btn btn-sm btn-outline">
              New program
            </Link>
          </div>
          <ProgramList />
        </div>
      </section>
    </div>
  );
};

export default Home;
