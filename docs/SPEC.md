# FeeLock 명세서

> 견적에서 본 수수료가 체결 때 내는 수수료다.
> Monad 메트로폴리스 제출작. 아이디어는 Klamp(EarthIsMine/klamp, ETHGlobal Tokyo 2026)에서 왔고, 코드는 새 저장소(EarthIsMine/FeeLock)에서 새로 작성한다. 포팅하는 파일은 커밋 메시지와 파일 주석에 출처를 남긴다.

---

## 0. Klamp와 무엇이 같고 무엇이 다른가

https://github.com/EarthIsMine/klamp

| 항목 | Klamp | FeeLock | 작업 성격 |
|---|---|---|---|
| 대표 풀 기록 위치 | ENSv2 `<token>.tokens.klamp.eth`의 `text/data("pool")` | 자체 `CanonicalPoolRegistry` 스토리지 + `PoolDeclared` 이벤트 | 재작성(단순화) |
| 발행자 증명 | CREATE2 / LiquidityLauncher 직접 / 일회용 배포자 경유, 3가지 | CREATE2 + 토큰 `owner()`, 2가지 | 1개 포팅, 1개 신규, 2개 제외 |
| 수수료 상한 훅 | Phase 2 로드맵(미구현, 프론트에서 mock 표기) | `FeeCommitHook`이 핵심 기능 | **신규, 가장 큰 작업** |
| 체결 시점 강제 | 없음(라우팅 회피만) | 풀 상한 + 스왑하는 쪽이 `hookData`로 보내는 `maxFee`, `beforeSwap`에서 revert | 신규 |
| 공격 훅 | `QuoteAwareFeeHook`(V4Quoter가 sender면 0.05%, 아니면 10%) | 그대로 + 상태를 뒤집는 훅(선택) | 포팅 + 신규 |
| SDK 판정 | `allow / requote_canonical / requote_static / hold` | `SAFE / UNVERIFIED / FEE_MISMATCH / LOOKUP_FAILED` | 재설계 |
| 견적 검증 | V4Quoter 한 번 | V4Quoter 견적 vs 사용자 주소로 라우터 `eth_call`, 이중 시뮬레이션 | 신규 |
| 조회 상태값 | `registered / not_registered / lookup_failed` | 그대로 유지 | 포팅 |
| 네트워크 | Sepolia (v4 공식 배포 + ENSv2 Beta) | Monad. v4 공식 배포는 메인넷(143)만 있고 테스트넷은 없음 | 배포 전략 새로 정함 |
| 의존성 | liquidity-launcher, ens-contracts 서브모듈 경유, remappings 복잡 | v4-core, v4-periphery, forge-std만 | 단순화 |
| 프론트 | Next.js 터미널(`web/`) + Vite 지갑 dApp(`dex/`) 두 개 | Vite 앱 하나 | 통합 |
| 백엔드 | 없음(정적 페이지 + 브라우저 RPC) | 없음. 선택 작업으로 풀 인덱서 워커 | 신규(P2) |

포팅해서 재사용할 만한 Klamp 코드:
- `contract/src/demo/QuoteAwareFeeHook.sol` (거의 그대로)
- `contract/test/QuoteDivergenceAttack.t.sol` (v4-core 로컬 배포 기반 공격 테스트 구조)
- `contract/src/demo/DemoLaunchpad.sol`, `PoolSeeder.sol` (레지스트리 호출부와 훅만 교체)
- `CanonicalPoolRegistrar._record`의 검증 로직(`TokenNotDeployed`, `TokenNotInPool`, `AlreadyRecorded`, `extsload`로 `PoolNotInitialized` 확인)
- `contract/sdk/poolKey.ts`, `compareRoutes.ts`의 입력 검증, 그리고 "조회 실패는 절대 미등록으로 취급하지 않는다"는 원칙

버리는 것: ENSv2 연동 전부(`Phase1Setup`, `EnsDeploy`, `EnsArtifacts`, seal 스크립트), LiquidityLauncher 경로(Monad에 Pools.trade 런치 스택이 있는지 불확실하고 하루 범위를 넘음), `launchEventFallback.ts`.

---

## 1. 결정해야 할 것 (구현 전에 정함)

1. **데모 네트워크.** Uniswap v4 공식 배포는 Monad 메인넷에만 있다.
   - (권장) 로컬 개발과 테스트는 anvil 로컬 체인 + Monad 메인넷 포크. 제출용 온체인 배포는 Monad 테스트넷에 v4-core `PoolManager`, v4-periphery `V4Quoter`, 자체 `DemoSwapRouter`를 직접 배포.
   - (대안) 메인넷 포크로만 데모 영상을 찍고 온체인 배포 생략. 해커톤이 테스트넷 배포를 요구하면 불가.
   - 공격 훅(`QuoteAwareFeeHook`)은 메인넷에 배포하지 않는다.
   - 라이선스: v4 코드는 2027-06-15까지 BUSL로 상업·프로덕션 사용이 제한된다. 테스트넷 데모 배포는 비프로덕션이지만, 자체 복사본을 메인넷에 프로덕션으로 올리지는 않는다. 메인넷은 공식 배포 주소만 쓴다.
   - 테스트넷 배포 범위: PoolManager, V4Quoter, (선택) StateView, DemoSwapRouter. 유동성은 런치패드와 시더가 `unlock` 콜백으로 직접 넣으므로 PositionManager, Permit2, Universal Router는 배포하지 않는다.
2. **스왑 라우터.** 테스트넷에는 Universal Router가 없으므로 hookData를 넘기는 최소 라우터 `DemoSwapRouter`를 쓴다. SDK의 Universal Router `V4_SWAP` 인코딩은 메인넷 포크용 선택 기능(P1).
3. **판정 4종의 이름.** 아래 4장 기준으로 확정. 제출 설명문은 3종(SAFE/UNVERIFIED/FEE_MISMATCH)으로 썼으므로, LOOKUP_FAILED는 "조회 실패 시 보류" 정도로 설명문에 한 줄 추가.

---

## 2. 저장소 구조

```text
FeeLock/
├── contracts/                    # Foundry
│   ├── src/
│   │   ├── CanonicalPoolRegistry.sol
│   │   ├── FeeCommitHook.sol
│   │   ├── interfaces/IFeeCommitHook.sol
│   │   └── demo/
│   │       ├── DemoToken.sol
│   │       ├── DemoLaunchpad.sol
│   │       ├── PoolSeeder.sol
│   │       ├── DemoSwapRouter.sol
│   │       ├── QuoteAwareFeeHook.sol      # Klamp 포팅
│   │       └── StateFlipFeeHook.sol       # P1
│   ├── test/
│   │   ├── CanonicalPoolRegistry.t.sol
│   │   ├── FeeCommitHook.t.sol
│   │   ├── FeeCommitHook.fuzz.t.sol
│   │   ├── QuoteDivergenceAttack.t.sol    # Klamp 포팅
│   │   ├── FeeLockE2E.t.sol
│   │   ├── MonadFork.t.sol                # FOUNDRY_PROFILE=fork
│   │   └── utils/Deployers.sol            # v4-core 로컬 배포 헬퍼
│   ├── script/
│   │   ├── DeployCore.s.sol               # 테스트넷/로컬 전용: PoolManager, V4Quoter, DemoSwapRouter
│   │   ├── DeployFeeLock.s.sol            # Registry, FeeCommitHook(HookMiner)
│   │   └── DemoSetup.s.sol                # 런치, 정상 풀, 공격 풀, 유동성
│   ├── deployments/<chainId>.json
│   ├── foundry.toml
│   └── remappings.txt
├── packages/
│   └── sdk/                      # @feelock/sdk (TypeScript, viem)
│       ├── src/
│       │   ├── abi/               # forge out에서 생성 (scripts/sync-abi.ts)
│       │   ├── config.ts
│       │   ├── poolKey.ts
│       │   ├── registry.ts
│       │   ├── feeCommit.ts
│       │   ├── quote.ts
│       │   ├── simulate.ts
│       │   ├── judge.ts
│       │   ├── guard.ts
│       │   ├── swap.ts
│       │   └── index.ts
│       ├── test/*.test.ts
│       └── cli/demo.ts            # naive vs feelock 터미널 데모
├── apps/
│   ├── web/                      # Vite + React + viem
│   │   └── src/
│   │       ├── lib/{chain,wallet,deployments,sdk}.ts
│   │       ├── components/{SwapPanel,PoolList,PoolBadge,GuardToggle,VerdictCard,FeeCompare,TxReceipt,Explainer}.tsx
│   │       └── App.tsx
│   └── worker/                   # P2: 풀 인덱서
│       └── src/{index,scan,classify,store}.ts
├── scripts/sync-abi.ts
├── docs/{SPEC.md,DEMO.md}
├── package.json, pnpm-workspace.yaml   # TS 패키지만 pnpm 워크스페이스. contracts는 Foundry 단독
└── README.md
```

Klamp처럼 컨트랙트 툴체인과 JS 툴체인은 섞지 않는다. 대신 Klamp와 달리 SDK, 웹, 워커는 pnpm 워크스페이스 하나로 묶어서 웹이 `@feelock/sdk`를 직접 import한다.

---

## 3. 컨트랙트

공통: Solidity 0.8.26, `evm_version = "cancun"`(v4가 transient storage 사용), optimizer 200, 의존성은 `lib/v4-core`, `lib/v4-periphery`, `lib/forge-std` 서브모듈. Monad 문서 권장대로 Foundry v1.8.0 이상.

### 3.1 CanonicalPoolRegistry

역할: 토큰 발행자만 페어의 대표 풀을 한 번 선언. 이후 누구도(배포자 포함) 수정 불가. 소유자 없음, 업그레이드 없음.

```solidity
struct CanonicalPool { bytes32 poolId; PoolKey key; address issuer; uint64 declaredAt; }

mapping(address token => CanonicalPool) internal _canonical;

function declareByCreate2(address token, PoolKey calldata key, bytes32 salt, bytes32 initCodeHash) external;
function declareByOwner(address token, PoolKey calldata key) external;

function getCanonicalPool(address token) external view returns (bool declared, CanonicalPool memory);
function isCanonical(address token, bytes32 poolId) external view returns (bool);

event PoolDeclared(address indexed token, bytes32 indexed poolId, address indexed issuer, PoolKey key);

error NotIssuer(); error TokenNotDeployed(); error TokenNotInPool();
error AlreadyDeclared(); error PoolNotInitialized();
```

- `declareByCreate2`: `CREATE2(msg.sender, salt, initCodeHash) == token`. Klamp 경로 A 그대로. 런치패드가 런치 트랜잭션 안에서 호출.
- `declareByOwner`: `staticcall(token.owner()) == msg.sender`. 이미 배포된 Ownable 토큰용. owner가 없거나 호출 실패 시 `NotIssuer`. 약점(소유권 이전 가능, 먼저 선언한 owner가 확정)은 README에 명시.
- 공통 검증은 Klamp `_record`와 동일: 토큰 코드 존재, 토큰이 키에 포함, 미선언, `extsload(keccak256(poolId, POOLS_SLOT))`의 sqrtPrice != 0. `POOLS_SLOT = 6`은 서브모듈 v4-core 커밋과 Monad 메인넷 PoolManager 둘 다에 대해 테스트로 확인.
- ENS 의존성이 없으므로 SDK는 ABI 하나로 읽는다. Klamp의 "ABI 없이 표준 ENS로 읽힌다"는 장점은 포기하고, 대신 단순성과 Monad 배포 가능성을 얻는다.

### 3.2 FeeCommitHook

역할: 풀별로 수수료 상한(`maxFee`)을 생성 시점에 고정하고, 현재 수수료는 상한 안에서만 움직이게 하며, 체결 때 상한이나 스왑하는 쪽의 `maxFee`를 넘으면 revert.

```solidity
struct Commitment { uint24 maxFee; uint24 currentFee; address feeManager; bool exists; }

mapping(PoolId => Commitment) public commitments;

function initializePool(PoolKey calldata key, uint160 sqrtPriceX96, uint24 maxFee, uint24 initialFee, address feeManager)
    external returns (int24 tick);
function setFee(PoolKey calldata key, uint24 newFee) external;          // onlyFeeManager, newFee <= maxFee
function commitmentOf(PoolId id) external view returns (Commitment memory);
function FEELOCK_HOOK_VERSION() external pure returns (uint16);          // SDK 식별용

// hooks
function beforeInitialize(address sender, PoolKey calldata key, uint160) external returns (bytes4);
function beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata hookData)
    external returns (bytes4, BeforeSwapDelta, uint24);

event FeeCommitted(PoolId indexed id, uint24 maxFee, uint24 initialFee, address feeManager);
event FeeUpdated(PoolId indexed id, uint24 oldFee, uint24 newFee);

error InitializeOnlyThroughHook(); error NotDynamicFeePool(); error FeeAboveCommitment();
error FeeAboveUserLimit(uint24 fee, uint24 userMax); error NotFeeManager(); error UnknownPool();
```

- v4의 `initialize`는 hookData를 받지 않으므로, 커밋은 훅 자신이 `initializePool`에서 저장한 뒤 `poolManager.initialize`를 호출하는 방식으로 한다. `beforeInitialize`는 `sender == address(this)`가 아니면 revert. 커밋 없이 이 훅을 단 풀이 생기는 경로를 막는다.
- 키 조건: `key.hooks == address(this)`, `key.fee == LPFeeLibrary.DYNAMIC_FEE_FLAG`, `initialFee <= maxFee <= MAX_LP_FEE`.
- `beforeSwap`: `fee = currentFee`. `hookData.length >= 32`면 `userMax = abi.decode(hookData, (uint24))`, `fee > userMax`면 `FeeAboveUserLimit`. 반환은 `fee | OVERRIDE_FEE_FLAG`. `fee <= maxFee`는 `setFee`에서 이미 보장하지만 방어적으로 한 번 더 확인.
- V4Quoter도 같은 hookData로 시뮬레이션하므로 견적과 체결이 같은 규칙을 탄다.
- 권한 비트: `BEFORE_INITIALIZE | BEFORE_SWAP`. 주소는 v4-periphery `HookMiner`로 CREATE2 salt를 찾는다.
- 한계(문서에 명시): 체결 시점 강제는 FeeCommitHook 풀에만 적용된다. 임의의 악성 훅은 hookData를 무시하므로, 그 풀은 SDK가 라우팅에서 빼는 것으로 방어한다.

### 3.3 데모 컨트랙트 (`src/demo/`)

- `DemoToken`: 고정 공급 ERC20.
- `DemoLaunchpad`: Klamp 버전 기반. 한 트랜잭션에서 CREATE2 토큰 배포 → `FeeCommitHook.initializePool`(MON/토큰, maxFee 1%, initialFee 0.3%) → 단방향 유동성 잠금 → `registry.declareByCreate2`.
- `PoolSeeder`: 같은 페어에 공격 훅 풀을 만들고 유동성 공급. 공격 풀이 더 좋은 견적을 내도록 유동성과 가격을 맞춘다.
- `DemoSwapRouter`: `unlock` 콜백 기반 최소 exact-input 단일 홉 라우터. `PoolKey`, 방향, 금액, `minAmountOut`, `hookData`를 받는다. 네이티브 MON 입력 지원(데모 페어의 currency0 = MON).
- `QuoteAwareFeeHook`: Klamp 그대로. `sender == quoter`면 0.05%, 아니면 10%.
- `StateFlipFeeHook` (P1): 소유자가 견적과 체결 사이에 수수료를 올리는 훅. 이중 시뮬레이션으로도 못 잡는 경우를 보여주고, FeeCommitHook은 같은 시도를 상한에서 막는다는 대비용. Monad 비동기 실행 설명과 연결.

### 3.4 테스트

| 파일 | 내용 |
|---|---|
| `CanonicalPoolRegistry.t.sol` | 두 경로 성공, 5개 에러, 이벤트, 재선언 불가, 비 Ownable 토큰 |
| `FeeCommitHook.t.sol` | 훅 우회 초기화 차단, 정적 수수료 키 거부, setFee 상한/권한, hookData userMax revert, hookData 없을 때 동작, 견적 == 체결 |
| `FeeCommitHook.fuzz.t.sol` | 임의 setFee/스왑 시퀀스에서 적용 수수료 <= maxFee 불변식 |
| `QuoteDivergenceAttack.t.sol` | 공격 풀이 견적에서 이기고, 5% 슬리피지에서 revert, 15%에서 약 9.95% 손실 (Klamp 로컬 테스트 수치 재현. Klamp의 Sepolia 포크 측정값은 약 9.8%) |
| `FeeLockE2E.t.sol` | 런치 → 공격 풀 시딩 → naive 라우팅 손실 → 대표 풀 스왑 정상 |
| `MonadFork.t.sol` | Monad 메인넷(143) 포크에서 공식 PoolManager의 POOLS_SLOT 확인, 공식 V4Quoter로 FeeCommitHook 풀 견적 |

### 3.5 배포 스크립트

- `DeployCore.s.sol`: 체인에 v4가 없을 때만. PoolManager, V4Quoter, DemoSwapRouter. 메인넷(143)에서는 실행 거부.
- `DeployFeeLock.s.sol`: Registry, HookMiner로 FeeCommitHook.
- `DemoSetup.s.sol`: 런치, 공격 훅 배포와 풀 시딩. 체인 143에서는 공격 훅 배포 거부.
- 결과는 `deployments/<chainId>.json`에 기록(`fs_permissions`). 키는 환경 변수로만.
- Monad는 gas limit 전체를 청구하므로 스크립트와 SDK 모두 추정치에 작은 여유만 더한 명시적 gas limit을 쓴다.

`deployments/<chainId>.json` 스키마:

```json
{
  "chainId": 10143,
  "poolManager": "0x…", "quoter": "0x…", "router": "0x…",
  "registry": "0x…", "feeCommitHook": "0x…", "feeCommitHookCodeHash": "0x…",
  "demo": {
    "token": "0x…",
    "pools": [
      { "label": "canonical", "poolId": "0x…", "key": { "currency0": "0x…", "currency1": "0x…", "fee": 8388608, "tickSpacing": 60, "hooks": "0x…" } },
      { "label": "look-alike", "poolId": "0x…", "key": { } }
    ]
  },
  "deployBlock": 0
}
```

체인 ID는 배포 시점에 RPC로 다시 확인한다.

---

## 4. SDK (`@feelock/sdk`)

viem 기반, ESM, Node 22+. 테스트는 Klamp처럼 `tsx --test`.

### 4.1 모듈

- `config.ts`: `NetworkConfig { chainId, poolManager, quoter, router, registry, trustedFeeCommitHooks: {address, codeHash}[] }`. `deployments/*.json`에서 로드하는 헬퍼.
- `poolKey.ts`: Klamp 포팅. `hashPoolKey`, `isStatic`(훅 없음 + 동적 플래그 없음).
- `registry.ts`: `getCanonicalPool(client, cfg, token)` → `registered | not_registered | lookup_failed(reason)`. 체인 ID, 레지스트리 코드 존재, 반환 키의 poolId 재계산, 풀 초기화 여부를 확인. Klamp 원칙대로 어떤 실패도 `not_registered`로 바꾸지 않는다.
- `feeCommit.ts`: `getCommitment(client, cfg, key)` → `committed {maxFee, currentFee} | not_committed | lookup_failed`. 훅 주소가 신뢰 목록에 있고 `extcodehash`가 일치할 때만 `committed`.
- `quote.ts`: V4Quoter `quoteExactInputSingle`로 후보 풀 견적.
- `simulate.ts`: 라우터 스왑을 사용자 주소로 `eth_call`(네이티브 입력은 `stateOverride`로 잔액 보정, 실제와 같은 gasPrice). 견적 출력과 시뮬레이션 출력의 차이를 bps로 반환. 공격 훅의 "견적자에게만 낮은 수수료"를 잡는다.
- `judge.ts`: 홉별 판정을 합쳐 경로 판정.
- `guard.ts`: 공개 진입점.
- `swap.ts`: `DemoSwapRouter` calldata와 hookData(`abi.encode(uint24 userMaxFee)`) 생성, gas limit 계산. Universal Router 인코딩은 P1.

### 4.2 판정 규칙

토큰이 포함된 홉만 본다. 홉 판정:

| 조건 | 홉 판정 |
|---|---|
| 조회 실패(레지스트리, 커밋, 견적, 시뮬레이션 중 어느 것이든) | LOOKUP_FAILED |
| 이중 시뮬레이션 차이 > 허용 bps, 또는 커밋 풀인데 견적 수수료 > maxFee | FEE_MISMATCH |
| 정적 풀 | SAFE |
| 신뢰 FeeCommitHook 풀이고 maxFee <= 사용자 허용 수수료 | SAFE |
| 그 외 동적 훅 풀(대표 풀이라도 상한이 없으면) | UNVERIFIED (`canonical` 플래그는 사유로 첨부) |

경로 판정은 가장 나쁜 홉 기준: `FEE_MISMATCH > LOOKUP_FAILED > UNVERIFIED > SAFE`.

통합 측 권장 정책: SAFE → 진행, UNVERIFIED → SAFE 풀만으로 재견적 후 없으면 경고, FEE_MISMATCH → 차단, LOOKUP_FAILED → 보류(사용자 무시 불가, 재시도).

### 4.3 공개 API

```ts
export async function feelockGuard(input: {
  client: PublicClient; config: NetworkConfig; account: Address;
  token: Address; route: PoolKey[]; amountIn: bigint; zeroForOne: boolean;
  maxFeePips: number;           // 사용자 허용 수수료 (예: 10_000 = 1%)
  mismatchToleranceBps?: number; // 기본 10
}): Promise<{
  verdict: 'SAFE' | 'UNVERIFIED' | 'FEE_MISMATCH' | 'LOOKUP_FAILED';
  hops: HopReport[];            // 사유, 견적, 시뮬레이션 출력, 커밋 정보, canonical 여부
  hookData?: Hex;               // SAFE이고 FeeCommitHook 풀일 때
  gasLimit?: bigint;
}>;
```

### 4.4 CLI 데모 (`cli/demo.ts`)

`--mode naive`: 모든 후보 풀을 견적해 최고 견적 선택 → 공격 풀. `--mode feelock`: 같은 후보에 가드 적용 → 공격 풀 FEE_MISMATCH, 대표 풀 SAFE로 재견적. `--execute`는 `FEELOCK_PK` 환경 변수가 있을 때만. 프론트가 늦어지면 이 CLI가 데모 영상의 백업이 된다.

---

## 5. 프론트엔드 (`apps/web`)

Vite + React 19 + viem, EIP-1193 지갑. 정적 빌드. Klamp `dex/`의 wallet, chain, TxStatus 패턴을 참고하되 새로 작성.

화면 하나, 위에서 아래로:
1. 헤더: 로고, 네트워크(Monad 테스트넷), 지갑 연결.
2. `PoolList`: 데모 페어의 후보 풀 목록. 배지 `Canonical`, `Fee-committed (max x%)`, `Static`, `Unverified dynamic`. 견적 출력 표시.
3. `GuardToggle`: FeeLock off/on.
4. `SwapPanel`: 금액 입력, off면 최고 견적 풀, on이면 가드 판정 후 선택된 풀.
5. `VerdictCard`: 판정과 홉별 사유.
6. `FeeCompare`: 견적 수수료 vs 시뮬레이션/실제 체결 수수료, 손실액.
7. `TxReceipt`: 실행 결과와 실제 받은 수량, 익스플로러 링크.
8. `Explainer`: 문제, 구조, Why Monad(비동기 실행, gas limit 청구) 3단 설명.

데이터 출처: `deployments/<chainId>.json`을 빌드 시 import. RPC 실패 시 Klamp처럼 기록된 스냅샷을 표시하고 "Recorded snapshot" 라벨을 붙인다. 실패를 성공처럼 보이게 하지 않는다.

---

## 6. 워커 (`apps/worker`, P2)

백엔드 서버는 두지 않는다. 판정에 필요한 정보는 모두 RPC로 직접 읽을 수 있다. 다만 "이 페어에 어떤 풀이 있는가"는 이벤트를 훑어야 알 수 있으므로, 시간이 남으면 인덱서를 붙인다.

- PoolManager `Initialize` 이벤트와 Registry `PoolDeclared` 이벤트를 `deployBlock`부터 블록 범위 청크로 수집.
- 풀마다 `static / fee-committed / canonical / unverified-dynamic`으로 분류.
- 결과를 `data/pools.<chainId>.json`으로 저장하고 작은 HTTP 엔드포인트(`GET /pools?token=`)로 제공. 웹과 CLI는 있으면 이걸, 없으면 deployments 파일을 쓴다.
- Monad 풀 노드는 임의의 과거 상태를 제공하지 않으므로 상태 조회는 최신 블록 기준으로 하고, 이벤트 범위 조회 제한에 대비해 청크 크기를 설정값으로 둔다.

---

## 7. 커밋 순서

원칙: 커밋마다 빌드와 테스트가 통과한다. 메시지는 Conventional Commits(`feat(contracts): …`). 포팅 커밋은 본문에 `Ported from EarthIsMine/klamp <path>`를 남긴다. 우선순위: P0 제출 필수, P1 있으면 좋음, P2 시간 남으면.

| # | 커밋 | 내용 | 확인 | 우선순위 | 예상 |
|---|---|---|---|---|---|
| 1 | `chore: scaffold repository` | README 골격, LICENSE, .gitignore, pnpm 워크스페이스, `docs/SPEC.md`(이 문서) | — | P0 | 0.3h |
| 2 | `chore(contracts): init foundry with v4-core and v4-periphery` | 서브모듈, remappings, foundry.toml(default, fork 프로파일, Monad RPC는 환경 변수) | `forge build` | P0 | 0.5h |
| 3 | `test(contracts): add v4 local deployers` | `test/utils/Deployers.sol` | `forge build` | P0 | 0.3h |
| 4 | `feat(contracts): add CanonicalPoolRegistry` | 3.1 전체 + 테스트 | `forge test --mc CanonicalPoolRegistry` | P0 | 1h |
| 5 | `feat(contracts): add FeeCommitHook with committed fee cap` | initializePool, setFee, beforeInitialize 가드, 상한 강제 + 테스트 | `forge test --mc FeeCommitHook` | P0 | 1.5h |
| 6 | `feat(contracts): enforce swapper maxFee from hookData` | beforeSwap userMax + 테스트 + fuzz | 같음 | P0 | 0.7h |
| 7 | `feat(contracts): port QuoteAwareFeeHook attack demo` | Klamp 공격 훅 + `QuoteDivergenceAttack.t.sol` | `forge test --mc QuoteDivergence` | P0 | 0.5h |
| 8 | `feat(contracts): add demo launchpad, seeder and swap router` | DemoToken, DemoLaunchpad, PoolSeeder, DemoSwapRouter + `FeeLockE2E.t.sol` | `forge test` | P0 | 1.5h |
| 9 | `feat(contracts): add deploy scripts and local deployment` | 3.5 스크립트 3개, anvil 실행 결과 `deployments/31337.json` | `forge script … --rpc-url localhost` | P0 | 1h |
| 10 | `test(contracts): add Monad mainnet fork test` | `MonadFork.t.sol` | `FOUNDRY_PROFILE=fork forge test` | P1 | 0.5h |
| 11 | `chore(sdk): scaffold package and sync ABIs` | 패키지, `scripts/sync-abi.ts`, `config.ts`, `poolKey.ts` | `pnpm -F @feelock/sdk typecheck` | P0 | 0.5h |
| 12 | `feat(sdk): read canonical pools and fee commitments` | `registry.ts`, `feeCommit.ts` + 테스트(anvil) | `pnpm -F @feelock/sdk test` | P0 | 1h |
| 13 | `feat(sdk): quote and dual-simulate candidate pools` | `quote.ts`, `simulate.ts` + 테스트 | 같음 | P0 | 1h |
| 14 | `feat(sdk): add judge and feelockGuard` | `judge.ts`, `guard.ts`, `swap.ts` + 판정 표 전 케이스 테스트 | 같음 | P0 | 1h |
| 15 | `feat(sdk): add naive vs feelock CLI demo` | `cli/demo.ts`, 로컬 anvil에서 시나리오 재현 | `pnpm -F @feelock/sdk demo` | P0 | 0.5h |
| 16 | `chore(contracts): deploy to Monad testnet` | `deployments/10143.json`, 배포 tx 링크 | CLI를 테스트넷에 실행 | P0 | 0.7h |
| 17 | `feat(web): scaffold app with chain and wallet` | Vite, chain 설정, 지갑 연결, deployments 로드 | `pnpm -F web build` | P0 | 0.5h |
| 18 | `feat(web): pool list, guard toggle and swap` | PoolList, PoolBadge, GuardToggle, SwapPanel, VerdictCard | 테스트넷 수동 확인 | P0 | 1.5h |
| 19 | `feat(web): fee comparison, receipts and explainer` | FeeCompare, TxReceipt, Explainer, 스냅샷 폴백 | 같음 | P0 | 1h |
| 20 | `feat(contracts): add StateFlipFeeHook demo` | 3.3 P1 훅 + 테스트, 웹 시나리오 2 | `forge test` | P1 | 0.7h |
| 21 | `feat(sdk): encode Universal Router V4_SWAP` | 메인넷 포크용 | 포크 테스트 | P1 | 0.7h |
| 22 | `feat(worker): index pools and serve classification` | 6장 | 로컬 실행 | P2 | 1.5h |
| 23 | `ci: run forge and sdk tests` | GitHub Actions | — | P2 | 0.3h |
| 24 | `docs: README, demo script and submission notes` | Why Monad, Klamp 출처, 실행 방법, `docs/DEMO.md`, 배포 주소 표 | — | P0 | 1h |

P0 합계 약 17시간. 하루 안에 끝내려면 10번과 20번 이후를 미루고, 17~19번의 UI 범위를 줄이거나 15번 CLI를 데모 영상의 주 화면으로 쓴다. 24번은 마지막이지만, 1번에서 만든 README 골격을 중간중간 채운다.

---

## 8. 로컬 개발 환경 (Ubuntu)

```sh
curl -L https://foundry.paradigm.xyz | bash && foundryup   # v1.8.0 이상
corepack enable && corepack prepare pnpm@latest --activate  # Node 22+
git submodule update --init --recursive

# 로컬 체인
anvil
# Monad 메인넷 포크 (RPC URL은 환경 변수)
anvil --fork-url "$MONAD_MAINNET_RPC_URL"

cd contracts && forge build && forge test
pnpm install && pnpm -F @feelock/sdk test
```

환경 변수: `MONAD_MAINNET_RPC_URL`, `MONAD_TESTNET_RPC_URL`, `FEELOCK_PK`(배포와 실행용, 커밋 금지). `.env.example`만 커밋한다.

---

## 9. 제출 설명문과의 일치 확인

- Description의 "swapper가 hookData로 maxFee 전달, beforeSwap에서 revert" → 커밋 6.
- "SDK가 서명 전에 차단, 온체인은 백스톱" → 커밋 13~15.
- 데모 "0.05% 견적이 10%로 체결" → 커밋 7, 8, 15, 18.
- "강제로 보내면 FeeCommitHook이 revert" → 커밋 6의 테스트와 웹 시나리오.
- 판정 이름 → 설명문에 LOOKUP_FAILED(보류) 한 줄 추가.
- Klamp 출처 → README와 포팅 커밋 본문.