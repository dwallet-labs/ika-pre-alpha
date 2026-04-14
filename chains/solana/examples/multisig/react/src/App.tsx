import { useMemo, useState, useCallback, useEffect } from 'react';
import {
  ConnectionProvider, WalletProvider, useWallet, useConnection,
} from '@solana/wallet-adapter-react';
import { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-wallets';
import { PublicKey, Transaction, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import '@solana/wallet-adapter-react-ui/styles.css';

import { createIkaWebClient, type IkaDWalletWebClient } from '../../../../clients/typescript/src/grpc-web';
import {
  findMultisigPda, findTransactionPda, findApprovalRecordPda, findCpiAuthority,
  findMessageApprovalPda, parseMultisig, fetchTransactions, keccak256,
  buildCreateMultisigIx, buildCreateTransactionIx, buildApproveIx, buildRejectIx,
  MULTISIG_PROGRAM_ID, DWALLET_PROGRAM_ID,
  type MultisigAccount, type TransactionAccount,
} from './lib/program';

const RPC_URL = import.meta.env.VITE_RPC_URL || 'https://api.devnet.solana.com';
const GRPC_URL = import.meta.env.VITE_GRPC_URL || 'https://pre-alpha-dev-1.ika.ika-network.net:443';
const STATUS = ['ACTIVE', 'APPROVED', 'REJECTED'] as const;
const STATUS_COLOR = ['gold', 'green', 'red'] as const;

function Panel({ title, children, accent = 'cyan', glow }: { title: string; children: React.ReactNode; accent?: string; glow?: boolean }) {
  return (
    <div className={`border border-border bg-surface anim-in ${glow ? `shadow-[0_0_24px_-6px] shadow-${accent}/20` : ''}`}>
      <div className={`border-b border-border px-5 py-3 flex items-center gap-2`}>
        <div className={`w-1.5 h-1.5 bg-${accent}`} />
        <span className={`text-[10px] font-bold tracking-[0.15em] uppercase text-${accent}`}>{title}</span>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}
function Label({ children }: { children: React.ReactNode }) {
  return <label className="block text-[10px] uppercase tracking-[0.12em] text-dim mb-1.5 font-semibold">{children}</label>;
}
function Stat({ label, children, color = 'cyan' }: { label: string; children: React.ReactNode; color?: string }) {
  return (
    <div>
      <Label>{label}</Label>
      <div className={`text-2xl font-bold text-${color} leading-none`}>{children}</div>
    </div>
  );
}

function AppContent() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();

  const [ikaClient] = useState<IkaDWalletWebClient>(() => createIkaWebClient(GRPC_URL));

  // dWallet state
  const [dwalletPda, setDwalletPda] = useState<PublicKey | null>(null);
  const [dwalletAddr, setDwalletAddr] = useState<Uint8Array | null>(null);
  const [dwalletPublicKey, setDwalletPublicKey] = useState<Uint8Array | null>(null);

  // Multisig state
  const [multisigPda, setMultisigPda] = useState<PublicKey | null>(null);
  const [multisigData, setMultisigData] = useState<MultisigAccount | null>(null);
  const [transactions, setTransactions] = useState<{ pda: PublicKey; account: TransactionAccount }[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [signature, setSignature] = useState('');
  const [airdropping, setAirdropping] = useState(false);

  const doAirdrop = useCallback(async () => {
    if (!publicKey) return;
    setAirdropping(true);
    try {
      const sig = await connection.requestAirdrop(publicKey, 10 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
      setStatus('Airdropped 10 SOL');
    } catch (e: any) {
      setStatus(`Airdrop failed: ${e.message}`);
    }
    setAirdropping(false);
  }, [publicKey, connection]);

  const [createMembers, setCreateMembers] = useState(['', '', '']);
  const [createThreshold, setCreateThreshold] = useState(2);
  const [loadAddr, setLoadAddr] = useState('');
  const [proposeMsg, setProposeMsg] = useState('');

  const sendTx = useCallback(async (tx: Transaction): Promise<string> => {
    if (!publicKey || !sendTransaction) throw new Error('Wallet not connected');
    tx.feePayer = publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const sig = await sendTransaction(tx, connection);
    await connection.confirmTransaction(sig, 'confirmed');
    return sig;
  }, [publicKey, sendTransaction, connection]);

  const loadMultisig = useCallback(async (addr: PublicKey) => {
    const info = await connection.getAccountInfo(addr);
    if (!info?.data) throw new Error('Not found');
    const ms = parseMultisig(Buffer.from(info.data));
    setMultisigPda(addr); setMultisigData(ms);
    setDwalletPda(ms.dwallet);
    const txs = await fetchTransactions(connection, addr, ms.txIndex);
    setTransactions(txs);
    setStatus(`Loaded: ${ms.threshold}-of-${ms.memberCount}, ${ms.txIndex} txs`);
  }, [connection]);

  // ── Create dWallet + Multisig ──
  const handleCreateMultisig = useCallback(async () => {
    if (!publicKey) return;
    setLoading(true); setStatus('Creating dWallet via gRPC...');
    try {
      // 1. DKG via gRPC (mock commits on-chain + transfers authority to wallet)
      const dkg = await ikaClient.requestDKG(publicKey.toBytes());
      const curve = 2; // Curve25519
      // PDA seeds = ["dwallet", chunks_of(curve_u16_le || pubkey)]
      const payload = Buffer.alloc(2 + dkg.publicKey.length);
      payload.writeUInt16LE(curve, 0);
      Buffer.from(dkg.publicKey).copy(payload, 2);
      const chunks: Buffer[] = [];
      for (let i = 0; i < payload.length; i += 32) {
        chunks.push(payload.subarray(i, Math.min(i + 32, payload.length)));
      }
      const [dwPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('dwallet'), ...chunks],
        DWALLET_PROGRAM_ID,
      );

      // 2. Poll for dWallet on-chain
      setStatus('Waiting for dWallet on-chain...');
      for (let i = 0; i < 30; i++) {
        const info = await connection.getAccountInfo(dwPda);
        if (info?.data && info.data[0] === 2) break;
        await new Promise(r => setTimeout(r, 500));
      }

      // 3. Transfer authority to multisig CPI PDA
      setStatus('Transferring dWallet authority...');
      const [cpiAuth] = PublicKey.findProgramAddressSync(
        [Buffer.from('__ika_cpi_authority')], MULTISIG_PROGRAM_ID,
      );
      const transferData = Buffer.alloc(33);
      transferData[0] = 24; // IX_TRANSFER_OWNERSHIP
      cpiAuth.toBuffer().copy(transferData, 1);
      await sendTx(new Transaction().add({
        programId: DWALLET_PROGRAM_ID,
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: false },
          { pubkey: dwPda, isSigner: false, isWritable: true },
        ],
        data: transferData,
      }));

      // 4. Create multisig
      setStatus('Creating multisig...');
      const members = createMembers.filter(m => m.trim()).map(m => new PublicKey(m.trim()));
      const createKey = Keypair.generate().publicKey.toBytes();
      const [msPda, msBump] = findMultisigPda(createKey);
      await sendTx(new Transaction().add(
        buildCreateMultisigIx(msPda, publicKey, publicKey, createKey, dwPda, createThreshold, members, msBump),
      ));

      setDwalletPda(dwPda);
      setDwalletAddr(dkg.dwalletAddr);
      setDwalletPublicKey(dkg.publicKey);
      await loadMultisig(msPda);
      setStatus('Multisig created!');
    } catch (e: any) {
      setStatus(`Error: ${e.message}`);
    } finally { setLoading(false); }
  }, [publicKey, ikaClient, createMembers, createThreshold, sendTx, connection, loadMultisig]);

  const handlePropose = useCallback(async () => {
    if (!publicKey || !multisigPda || !multisigData || !dwalletPda || !dwalletPublicKey) return;
    setLoading(true); setStatus('Proposing...');
    try {
      const msgBytes = new TextEncoder().encode(proposeMsg);
      const hash = keccak256(msgBytes);
      const [maPda, maBump] = findMessageApprovalPda(2, dwalletPublicKey, 5, hash);
      const [txPda, txBump] = findTransactionPda(multisigPda, multisigData.txIndex);
      await sendTx(new Transaction().add(
        buildCreateTransactionIx(multisigPda, txPda, publicKey, publicKey, hash, publicKey.toBytes(), 0, maBump, txBump, msgBytes),
      ));
      setProposeMsg('');
      await loadMultisig(multisigPda);
      setStatus('Transaction proposed');
    } catch (e: any) { setStatus(`Error: ${e.message}`); }
    finally { setLoading(false); }
  }, [publicKey, multisigPda, multisigData, dwalletPda, dwalletPublicKey, proposeMsg, sendTx, loadMultisig]);

  const handleApprove = useCallback(async (txPda: PublicKey, tx: TransactionAccount) => {
    if (!publicKey || !multisigPda || !multisigData || !dwalletPda || !dwalletPublicKey) return;
    setLoading(true); setStatus('Approving...');
    try {
      const [arPda, arBump] = findApprovalRecordPda(txPda, publicKey);
      const [cpiAuth, cpiBump] = findCpiAuthority();
      const willQuorum = tx.approvalCount + 1 >= multisigData.threshold;
      const [maPda] = findMessageApprovalPda(2, dwalletPublicKey, 5, tx.messageHash);
      const sig = await sendTx(new Transaction().add(
        buildApproveIx(multisigPda, txPda, arPda, publicKey, publicKey, tx.txIndex, arBump, cpiBump,
          willQuorum ? { messageApproval: maPda, dwallet: dwalletPda, cpiAuthority: cpiAuth } : undefined),
      ));

      if (willQuorum && dwalletAddr) {
        setStatus('Quorum! Requesting signature via gRPC...');
        const presignId = await ikaClient.requestPresign(publicKey.toBytes(), dwalletAddr);
        const bs58chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        let n = BigInt(0);
        for (const c of sig) n = n * 58n + BigInt(bs58chars.indexOf(c));
        const txSigBytes = new Uint8Array(64);
        for (let i = 63; i >= 0; i--) { txSigBytes[i] = Number(n & 0xffn); n >>= 8n; }

        const msgBytes = new TextEncoder().encode(new TextDecoder().decode(tx.messageData));
        const result = await ikaClient.requestSign(publicKey.toBytes(), dwalletAddr, msgBytes, presignId, txSigBytes);
        setSignature(Buffer.from(result).toString('hex'));
        setStatus('Signature received!');
      } else {
        setStatus('Approved');
      }
      await loadMultisig(multisigPda);
    } catch (e: any) { setStatus(`Error: ${e.message}`); }
    finally { setLoading(false); }
  }, [publicKey, multisigPda, multisigData, dwalletPda, dwalletPublicKey, dwalletAddr, ikaClient, sendTx, loadMultisig]);

  const handleReject = useCallback(async (txPda: PublicKey, tx: TransactionAccount) => {
    if (!publicKey || !multisigPda) return;
    setLoading(true);
    try {
      const [arPda, arBump] = findApprovalRecordPda(txPda, publicKey);
      await sendTx(new Transaction().add(
        buildRejectIx(multisigPda, txPda, arPda, publicKey, publicKey, tx.txIndex, arBump),
      ));
      await loadMultisig(multisigPda);
      setStatus('Rejected');
    } catch (e: any) { setStatus(`Error: ${e.message}`); }
    finally { setLoading(false); }
  }, [publicKey, multisigPda, sendTx, loadMultisig]);

  useEffect(() => {
    if (!multisigPda) return;
    const id = setInterval(() => loadMultisig(multisigPda), 5000);
    return () => clearInterval(id);
  }, [multisigPda, loadMultisig]);

  const isMember = publicKey && multisigData?.members.some(m => m.equals(publicKey));

  return (
    <div className="min-h-screen bg-bg">
      {/* Top chrome */}
      <header className="border-b border-border bg-surface/80 backdrop-blur-sm px-6 py-3 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <img src="/icon-white.png" alt="Ika" className="h-7 w-auto opacity-90" />
          <div className="h-6 w-px bg-border" />
          <div>
            <h1 className="text-[13px] font-bold tracking-[0.2em] text-text uppercase">MULTISIG</h1>
            <p className="text-[9px] tracking-[0.15em] text-dim uppercase">dWallet Signing Control</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {status && (
            <div className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 ${status.includes('Error') ? 'bg-red' : 'bg-green'}`} />
              <span className="text-[10px] text-dim mono max-w-[300px] truncate">{status}</span>
            </div>
          )}
          {publicKey && (
            <button
              className="border-gold text-gold bg-gold-dim hover:bg-gold/20 text-[10px] px-3 py-1.5"
              onClick={doAirdrop}
              disabled={airdropping}
            >
              {airdropping ? '...' : 'Airdrop'}
            </button>
          )}
          <WalletMultiButton />
        </div>
      </header>

      <div className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-4 max-w-7xl mx-auto">
        <div className="space-y-4">
          <Panel title="Load Existing Multisig">
            <div className="space-y-2">
              <Label>Multisig PDA</Label>
              <input value={loadAddr} onChange={e => setLoadAddr(e.target.value)} placeholder="Address..." />
              <button className="w-full border-accent text-accent bg-accent/5 hover:bg-accent/10"
                onClick={() => loadMultisig(new PublicKey(loadAddr))} disabled={!loadAddr || loading}>Load</button>
            </div>
          </Panel>

          <Panel title="Create Vault" accent="green" glow>
            <p className="text-[10px] text-dim mb-3 leading-relaxed">Creates a dWallet via Ika network, then a multisig vault controlling it.</p>
            <div className="space-y-2">
              <Label>Threshold</Label>
              <input type="number" min={1} max={10} value={createThreshold} onChange={e => setCreateThreshold(Number(e.target.value))} />
              <Label>Members ({createMembers.filter(m => m.trim()).length})</Label>
              {createMembers.map((m, i) => (
                <div key={i} className="flex gap-1 mb-1">
                  <input value={m} onChange={e => { const n = [...createMembers]; n[i] = e.target.value; setCreateMembers(n); }}
                    placeholder={`Member ${i + 1}...`} />
                  {createMembers.length > 1 && (
                    <button className="text-red border-red px-2 text-[10px]"
                      onClick={() => setCreateMembers(createMembers.filter((_, j) => j !== i))}>X</button>
                  )}
                </div>
              ))}
              {createMembers.length < 10 && (
                <button className="text-dim border-border text-[10px] w-full" onClick={() => setCreateMembers([...createMembers, ''])}>+ Add</button>
              )}
              <button className="w-full border-green text-green bg-green-dim hover:bg-green/20 hover:shadow-[0_0_24px] hover:shadow-green/15"
                onClick={handleCreateMultisig} disabled={!publicKey || loading}>
                {loading ? 'Processing...' : 'Create dWallet + Vault'}
              </button>
            </div>
          </Panel>

          {multisigData && (
            <Panel title="New Operation" accent="gold">
              <div className="space-y-2">
                <Label>Message</Label>
                <textarea rows={2} value={proposeMsg} onChange={e => setProposeMsg(e.target.value)}
                  placeholder="Message to sign..." className="resize-none" />
                <button className="w-full border-gold text-gold bg-gold-dim hover:bg-gold/20 hover:shadow-[0_0_24px] hover:shadow-gold/15"
                  onClick={handlePropose} disabled={!publicKey || !proposeMsg || !isMember || loading}>
                  {!isMember ? 'Not a Signer' : loading ? 'Processing...' : 'Submit Operation'}
                </button>
              </div>
            </Panel>
          )}
        </div>

        <div className="lg:col-span-2 space-y-4">
          {multisigData && multisigPda && (
            <Panel title="Vault Status" glow>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-6">
                <Stat label="Threshold" color="cyan">
                  {multisigData.threshold}<span className="text-dim text-base font-normal">/{multisigData.memberCount}</span>
                </Stat>
                <Stat label="Transactions" color="gold">{multisigData.txIndex}</Stat>
                <div>
                  <Label>dWallet</Label>
                  <div className="text-xs mono text-cyan/80 break-all">{dwalletPda?.toBase58().slice(0, 20)}...</div>
                </div>
                <div>
                  <Label>Multisig PDA</Label>
                  <div className="text-xs mono text-cyan/80 break-all">{multisigPda.toBase58().slice(0, 20)}...</div>
                </div>
              </div>
              <Label>Signers</Label>
              <div className="mt-2 space-y-1.5">
                {multisigData.members.map((m, i) => {
                  const isYou = publicKey && m.equals(publicKey);
                  return (
                    <div key={i} className={`flex items-center gap-2.5 px-3 py-2 border ${isYou ? 'border-green/30 bg-green-dim' : 'border-border bg-bg'}`}>
                      <div className={`w-1.5 h-1.5 ${isYou ? 'bg-green' : 'bg-dim'}`} />
                      <span className={`text-xs mono ${isYou ? 'text-green' : 'text-text/70'}`}>{m.toBase58()}</span>
                      {isYou && <span className="text-[9px] font-bold text-green tracking-widest uppercase ml-auto">you</span>}
                    </div>
                  );
                })}
              </div>
            </Panel>
          )}

          {multisigData && (
            <Panel title={`Operations (${transactions.length})`} accent="gold">
              {transactions.length === 0 ? (
                <div className="text-dim text-xs py-12 text-center tracking-widest uppercase">No pending operations</div>
              ) : (
                <div className="space-y-3">
                  {transactions.map(({ pda, account: tx }) => {
                    const statusColor = STATUS_COLOR[tx.status];
                    return (
                      <div key={pda.toBase58()} className={`border border-border bg-bg anim-in`}>
                        <div className={`flex items-center justify-between px-4 py-2.5 border-b border-border`}>
                          <div className="flex items-center gap-3">
                            <span className="mono text-dim text-[11px]">TX-{String(tx.txIndex).padStart(3, '0')}</span>
                            <div className={`flex items-center gap-1.5 px-2 py-0.5 border border-${statusColor}/30 bg-${statusColor}-dim`}>
                              <div className={`w-1.5 h-1.5 bg-${statusColor}`} />
                              <span className={`text-[9px] font-bold uppercase tracking-widest text-${statusColor}`}>{STATUS[tx.status]}</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-3 text-[11px]">
                            <span className="text-green font-semibold">{tx.approvalCount}</span>
                            <span className="text-dim">/</span>
                            <span className="text-red font-semibold">{tx.rejectionCount}</span>
                            <span className="text-dim text-[9px] ml-1">({multisigData.threshold} req)</span>
                          </div>
                        </div>
                        <div className="px-4 py-3">
                          <div className="bg-bg border border-border p-3 mono text-[12px] text-cyan/90 mb-3">
                            {tx.messageData.length > 0 ? new TextDecoder().decode(tx.messageData) : '(empty)'}
                          </div>
                          {tx.status === 0 && isMember && (
                            <div className="flex gap-2">
                              <button className="flex-1 border-green text-green bg-green-dim hover:bg-green/20 hover:shadow-[0_0_16px] hover:shadow-green/10"
                                onClick={() => handleApprove(pda, tx)} disabled={loading}>Approve</button>
                              <button className="flex-1 border-red text-red bg-red-dim hover:bg-red/20 hover:shadow-[0_0_16px] hover:shadow-red/10"
                                onClick={() => handleReject(pda, tx)} disabled={loading}>Reject</button>
                            </div>
                          )}
                          {tx.status === 1 && (
                            <div className="flex items-center gap-2 text-[11px] text-green border border-green/20 bg-green-dim px-3 py-2">
                              <div className="w-2 h-2 bg-green" />
                              <span className="font-semibold tracking-wider uppercase">Signed &mdash; MessageApproval created</span>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Panel>
          )}

          {signature && (
            <Panel title="Signature Result" accent="green" glow>
              <div className="bg-bg border border-green/20 p-4 mono text-[12px] text-green break-all leading-relaxed">
                {signature}
              </div>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider><AppContent /></WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
