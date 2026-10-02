import { CreateProgramForm } from "./_components/CreateProgramForm";
import type { NextPage } from "next";
import { getMetadata } from "~~/utils/scaffold-hbar/getMetadata";

export const metadata = getMetadata({
  title: "Create a program · Earmark",
  description: "Escrow a stablecoin into purpose-bound vouchers that settle themselves.",
});

const NewProgram: NextPage = () => {
  return (
    <div className="px-5 py-10 max-w-5xl mx-auto w-full flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold m-0">Create a program</h1>
        <p className="opacity-70 m-0">
          Set a budget, say what it is for, and let the network enforce it until the money is spent or returned.
        </p>
      </div>
      <CreateProgramForm />
    </div>
  );
};

export default NewProgram;
