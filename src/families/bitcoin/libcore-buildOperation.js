// @flow

async function bitcoinBuildOperation({
  coreOperation
}: {
  coreOperation: any
}) {
  const hash = coreOperation.getTransactionHash();
  return { hash };
}

export default bitcoinBuildOperation;
