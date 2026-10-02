import { notFound } from "next/navigation";
import { ProgramDashboard } from "./_components/ProgramDashboard";
import type { NextPage } from "next";

type Props = { params: Promise<{ id: string }> };

const ProgramPage: NextPage<Props> = async ({ params }) => {
  const { id } = await params;
  if (!/^\d+$/.test(id) || id === "0") notFound();

  return (
    <div className="px-5 py-10 max-w-6xl mx-auto w-full">
      <ProgramDashboard id={BigInt(id)} />
    </div>
  );
};

export default ProgramPage;
