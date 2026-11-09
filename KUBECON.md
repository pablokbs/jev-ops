# Kubernetes, Meet Jev: Fast Decisions, Real Pods

## Kubernetes Automation Day North America · November 9, 2026

[![KubeAuto Day North America](./demo/live-cluster/jev-ops.png)](https://kubeauto.day/north-america)

**Pablo Fredrikson · Principal Engineer, Bitso**  
Presented at [Kubernetes Automation Day North America](https://kubeauto.day/north-america), co-located with KubeCon + CloudNativeCon NA 2026 in Salt Lake City.

## Thanks for coming!

This page collects the project, a quick way to try it, and links about the event. Save it and come back when you want to experiment with Jev and Kubernetes diagnostics.

## What is Jev?

[jev-ops](https://github.com/nemke82/jev-ops) is an extensible CLI for DevOps and SRE diagnostics. It takes operational text—such as Kubernetes pod status, events, and logs—and evaluates it against a diagnostic pack. The Kubernetes pack asks Jev for structured decisions: workload health, likely root cause, whether attention is needed, and severity.

```text
Kubernetes signals → jev-ops → Kubernetes diagnostic pack → Jev
                                                       ↓
                           health · root cause · attention · severity
```

The core stays technology-agnostic; the pack supplies the Kubernetes vocabulary and diagnostic instructions. Jev returns typed decisions with confidence and probability information, rather than prose that a script has to guess how to parse.

## Try it

### Requirements

- Rust toolchain (for building from source)
- `kubectl` configured for a cluster, or sample/piped diagnostic text
- A TypeSafe API key for live Jev inference; get one from [TypeSafe](https://typesafe.ai/)

### Build and inspect

```bash
git clone https://github.com/nemke82/jev-ops.git
cd jev-ops
cargo build --release

# See available packs and inspect the Kubernetes pack
./target/release/jev-ops packs list
./target/release/jev-ops packs show kubernetes
```

### Analyze your cluster

Set your API key, then pass Kubernetes output to the CLI:

```bash
export TYPESAFE_API_KEY="ts_live_..."

kubectl get pods -A | ./target/release/jev-ops analyze kubernetes
```

For more useful context when investigating a problem, include events, pod details, and relevant logs:

```bash
{
  echo '=== Pods ==='
  kubectl get pods -A -o wide
  echo '=== Recent events ==='
  kubectl get events -A --sort-by=.lastTimestamp | tail -n 100
  echo '=== Pod description ==='
  kubectl describe pod -n NAMESPACE POD_NAME
  echo '=== Container logs ==='
  kubectl logs -n NAMESPACE POD_NAME --all-containers --tail=100
} | ./target/release/jev-ops analyze kubernetes
```

Replace `NAMESPACE` and `POD_NAME` with the workload you are investigating. The Kubernetes pack accepts diagnostic text (up to its configured input limit); provide only the context needed for the question and avoid sending secrets or sensitive customer data to an external inference service.

For automation, request JSON output:

```bash
kubectl get pods -A | ./target/release/jev-ops analyze kubernetes --json
```

Live inference requires a valid API key. The CLI intentionally does not silently substitute mock output when the key is missing. The explicit `--provider mock` mode is useful for offline exploration and tests, but is keyword-based and **not suitable for operational decisions**.

> **Safety:** treat the result as diagnostic assistance, not an instruction to make production changes. Review the evidence and use your normal operational approval process before taking action.

## Links

- [Project repository](https://github.com/nemke82/jev-ops)
- [Kubernetes diagnostic pack](https://github.com/nemke82/jev-ops/tree/main/packs/kubernetes)
- [KubeAuto Day North America — event details](https://kubeauto.day/north-america)
- [KubeAuto Day](https://kubeauto.day/)
- [TypeSafe System One](https://docs.typesafe.ai/introduction)

## About the speaker

Pablo Fredrikson is a Principal Engineer at Bitso and creates technical content as Pelado Nerd.

[GitHub](https://github.com/pablokbs) · [Pelado Nerd](https://peladonerd.com)
