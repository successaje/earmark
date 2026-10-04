import { DebugContracts } from "./_components/DebugContracts";
import type { NextPage } from "next";
import { getMetadata } from "~~/utils/scaffold-hbar/getMetadata";

export const metadata = getMetadata({
  title: "Debug Contracts · Earmark",
  description: "Read and call the deployed Earmark and DemoDollar contracts directly",
});

const Debug: NextPage = () => {
  return (
    <div className="flex flex-col w-full overflow-x-clip">
      <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-10 pb-6">
        <h1 className="text-3xl font-bold m-0">Debug contracts</h1>
        <p className="opacity-70 m-0 mt-1">
          Read and call the deployed contracts directly. Built from{" "}
          <code className="text-sm bg-base-300 px-1.5 py-0.5 rounded">packages/nextjs/app/debug</code>.
        </p>
      </div>
      <DebugContracts />
    </div>
  );
};

export default Debug;
