# LLM-JIT-Script v2 — Plan izgradnje korak po korak

> Teza projekta: nije "izvrši LLM kod brzo", nego **"učini kod koji je napisao nepouzdan model poverljivim i reproduktivnim"**.

---

## 0. Objašnjenje kao da imaš 5 godina

Zamisli da imaš **robota pomoćnika** u kuhinji. Robot je mnogo pametan — kažeš mu "napravi mi sendvič" i on zna šta je sendvič. Ali robot je i **mnogo nepredvidiv**: ponekad pokuša da zapali kuhinju, ponekad se zaglavi i meša isto testo zauvek, ponekad uzme nož koji mu nisi dao.

Ne možeš da mu veruješ. Ali ne možeš ni da ga ne koristiš — previše je koristan.

Zato mu **ne daš kuhinju**. Daš mu **malu sobicu sa zidovima, tri alata i tajmerom**, i napraviš četiri stvari:

1. **Prevodilac** — robot ti govori običnim rečima, a ti to pretvoriš u **strogu recept-karticu** napisanu jezikom koji se ne može pogrešno razumeti. Nema "malo soli" — piše "3 grama".
2. **Inspektor recepata** ⭐ — pre nego što se hrana počne praviti, inspektor pogleda karticu i kaže: *"Ovaj recept traje najviše 12 minuta i koristi samo šerpu i kašiku — može."* Ili: *"Ovaj recept se nikad ne završava — odbijam."* Inspektor **garantuje** vreme i alate **unapred**, pre prvog pokreta.
3. **Mala kuhinja sa tajmerom** — robot sme da koristi samo alate koje si mu lično dao, i tajmer ga isključi ako probije vreme. To je VM sa gas meteringom i capability-jima.
4. **Beležnica** — sve što robot uradi zapisuje se istim redosledom svaki put, pa možeš da **pustiš snimak ponovo** i dobiješ identičan rezultat. To je determinizam + replay.

I na kraju pozoveš drugare: *"Pokušajte da pobegnete iz moje kuhinjice."* To je **escape challenge** — i kad niko ne pobegne 10.000 puta, imaš dokaz koji se ne može osporiti.

**Ukratko:** LLM je mašina za ideje, ti praviš mašinu za **poverenje**.

---

## 1. Pravila rada (važi za svaki korak)

- Jedan korak = jedan mergovan PR = zelen CI = ažuriran `claims.json`.
- **Nikad** ne tvrdimo broj koji CI ne reprodukuje.
- Svaki korak ima *Definition of Done* — nije "radi", nego "dokazano".
- Ako korak probije vreme 2×, sečemo scope, ne produkujemo rok.

Struktura repozitorijuma:

```
core/          Rust: lexer, parser, HIR, verifier, bytecode, VM
core-wasm/     Rust → wasm32 (isti core, bez std gde treba)
web/           React + Monaco + trace viewer (Vite)
bench/         criterion / hyperfine, claims.json generator
corpus/        valid/invalid programi + red-team napadi + fuzz seeds
docs/          spec, plan, threats, izveštaji
proof/         Lean 4 dokaz (stretch)
```

---

## 2. Koraci

### S0 — Skelet (½ dana)
Cargo workspace, `wasm-pack`, Vite app, CI (fmt + clippy + test + bench).
**Done:** `pnpm dev` otvara stranicu; `pnpm bench` izvrši prazan benchmark i upiše `bench/out.json`.

> **Stanje mašine (provereno):** `node v22.12.0`, `npm 11.17.0`, `git 2.55` — OK.
> `cargo` / `rustc` / `wasm-pack` **nisu instalirani** → prvi potez je `rustup` (rustup.rs, MSVC toolchain na Windows-u).
> Ako ne želiš Rust odmah: S0–S1 rade bez njega, a VM iz S2 se prvo piše u TypeScript-u, pa se seli u Rust kad se dokaže da arhitektura radi.

### S1 — Spec jezika v0.1 (2–3 dana) — *na papiru, bez koda*
EBNF gramatika, tipovi, memorijski model, **tabela cene po instrukciji** (gas model).
**Done:** `docs/spec-v0.1.md` + 20 primera programa (10 validnih, 10 koje moraju da se odbiju, sa razlogom).

### S2 — Stack VM v0 u Rust-u (5–7 dana)
Opcodes: `const, add, sub, mul, cmp, jmp, jz, load, store, call, ret, halt`. Arena alokator u linearnoj memoriji. Gas brojač po basic bloku (ne po instrukciji — 5–30% overhead je realan, izmeriti).
**Done:** 5 ručno napisanih programa (faktorijel, fib, suma niza, arena alokacija, namerna greška) daju tačan izlaz; **izmeren** gas overhead u `claims.json`.

> Izvedeno u TypeScript-u, ne u Rust-u (`src/core/{isa,program,vm}.ts`, ISA spec `docs/spec-v0.2-isa.md`). Gas tabela, metering pravilo i semantika su identični — Rust donosi samo brzinu, pa se seli u S8. Rezultat: 40.7M instrukcija/s, gas check 1.9 ns, overhead ~2.6% na 3 bloka po 9 instrukcija.

> **S3 napomena:** izvedeno kao **jedna** implementacija frontenda (`src/core/{lexer,parser,check,lower}.ts`), ne dve. Uloga drugog implementatora prešla je na korpus: 10 programa moraju da se izvrše do tačnog rezultata, 10 moraju da se odbiju sa tačnim kodom. Diferencijalno testiranje TS vs Rust VM ostaje u S4/S8, gde Rust VM zaista postoji.

### S3 — Frontend: lexer → parser → typed HIR → bytecode (7 dana)
Parser iz S1 spec-a (`pest`/`nom`), typechecker, lowering. **Druga implementacija istog jezika u TS-u** (interpreter) — namerno, radi diferencijalnog testiranja.
**Done:** `proptest` generiše 1000 slučajnih programa; TS interpreter i Rust VM daju **identičan** izlaz na svih 1000.

> **S4 izvedeno:** `src/core/trace.ts` beleži tok blokova i hesira ga FNV-1a; `RunOptions.onBlock` je kuka u VM-u. Testovi: isti program+argumenti → isti hash; različiti argumenti → različit hash; metering on/off → identičan tok blokova; trap je deo identiteta trace-a; replay daje identičan tok. **Ostaje** cross-engine poređenje (JS vs Rust vs WASM) — čeka Rust VM iz S8.

### S4 — Determinizam + replay (4–5 dana)
Seedovan RNG, virtualni sat, determinističke mape, kanonizacija NaN, **sopstvene** implementacije `sin/cos/exp` (jer `Math.sin` nije bit-identičan kroz engine-e). Binarni trace format.
**Done:** isti program → identičan hash trace-a na (browser JS, native Rust, WASM). Fuzzer u CI-ju: 10⁶ izvršavanja, 0 divergencija.

### S5 — Verifikator + Z3 gas bound (2–3 nedelje) ⭐ *najvažniji korak*
Abstract interpreter (interval + const + dužina niza), **inferencija granica petlji** (size-change principle), `gas_bound = Σ(basic_block_cost × iter_bound)`, Z3 za integer obligations. Izlaz: **sertifikat** (JSON) sa dokazanim bound-om ili `REJECT` + razlog.
**Done:** korpus od 200 programa — **0 prihvaćenih** programa prekorači bound u izvršavanju; **0 odbijenih** validnih programa (provereno puštanjem sa visokim runtime gasom).

> **S5 izvedeno:** `src/core/verify.ts` + `src/core/cost.ts`. Umesto Z3 za sada: strukturni model troškova koji 1:1 prati lowering, sa linearnim formama nad parametrima. Svaki prihvaćen program se pušta sa **dokazanim bound-om kao jedinim budžetom** — ako dokaz potceni gas, dobije se `OutOfGas` i build pada. Rezultat: 10/10 unutar bound-a, 0 lažnih prihvatanja, 5/10 bound-ova tačno do gasa (npr. `nested_sweep` 585/585). Z3 i size-change ostaju za S5b.
>
> **Bug koji je ovo otkrilo (i zašto je važan):** `CONST 0; RET` je delio blok sa `return`, pa ga je VM naplaćivao i kada je nedostižan. Isto za telo petlje koje je počinjalo u bloku uslova. Pravilo je sada u ISA specu: **blok nikad ne sadrži instrukcije dve različite putanje**.
**Rizik:** ako probije 3 nedelje → fallback: samo runtime metering + pošteno umanjen claim. Ne lažemo u tabeli.

> Fallback nije bio potreban, ali je otkrio pravu stvar: bound je bio **nesiguran** (potcenjen) dok god je lowering mešao putanje u isti blok. Test „pusti sa bound-om kao jedinim budžetom“ je jedini razlog što je to izašlo na videlo pre nego što je claim objavljen.

> **Status v0.1 je zatvoren:** kompajler, VM, verifikator i deterministički trace rade i pokriveni su sa 63 testa. S6–S9 su aditivne faze (capability-ji traže jezik sa efektima, S7 traži lokalni model, S8 Rust VM, S9 javni CTF) i imaju svoje specifikacije u ovom planu.

### S6 — Capability runtime (5 dana)
Grant model (atenuabilan), nema ambient authority (nema globalnog `fetch`/`Date`/`localStorage`).
**Done:** korpus od 100 modelom generisanih napada (eksfiltracija, alloc bomb, loop bomb, capability forgery, timing) — svaki ima test koji dokazuje kontejnment.

### S7 — LLM front-end (5–7 dana)
Constrained decoding (JSON-schema → grammar), type-directed repair loop, **model predlaže property-je → fuzzer ih falsifikuje → pušta se samo preživeli program**.
**Done:** 200 held-out NL zadataka; upisan success rate, p99 latencija, cena/zadatak.

### S8 — WASM backend / brza staza (opciono, 5 dana)
Isti bytecode → WASM modul; perf tabela vs V8 / QuickJS / Wasmtime.
**Done:** `claims.json` sa svim tri kolone, reproduktivno u CI-ju.

### S9 — Escape challenge (vikend)
Javna instanca VM-a, pravila, log svih pokušaja, objavljen izveštaj.
**Done:** `report/YYYY-MM.md` sa brojem pokušaja i brojem begova.

### S10 — Lean 4 dokaz (stretch, 2+ nedelje)
Progress + preservation za core calculus; dokaz da verifikovani subset poštuje gas bound.
**Done:** `lake build` prolazi bez `sorry`.

---

## 3. Realan raspored (≈10h nedeljno)

| Nedelje | Koraci | Rezultat koji možeš da pokažeš |
|---|---|---|
| 1 | S0, S1 | spec + prazan ali zelen projekat |
| 2–3 | S2 | VM izvršava programe, prvi benčevi |
| 4–5 | S3 | NL-ish program → bytecode, dva nezavisna implementatora |
| 6 | S4 | replay radi kroz 3 engine-a |
| 7–9 | S5 | **verifikator sa dokazanim gas bound-om** |
| 10 | S6 | red-team korpus, 0 proboja |
| 11 | S7 | LLM → kod → izvršavanje, sa brojevima |
| 12 | S8 | perf tabela |
| 13 | S9 | escape challenge + objavljen izveštaj |
| 14+ | S10 | dokaz (ako ide) |

---

## 4. Šta mi treba od tebe (odluke pre S0)

1. **Ime** projekta (predlog: `gascage`).
2. **Primarni target:** browser-first ili React Native-first? (Browser-first je brži za demo; RN dolazi kasnije.)
3. **LLM provajder** za S7 — bilo koji OpenAI-kompatibilan sa JSON-schema outputom radi; ključ ide na server, nikad u klijent.
4. **Vreme nedeljno** koje realno možeš da uložiš.
