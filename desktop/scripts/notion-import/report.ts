import type { DryRunOutput, NotionImport, PublishFailure } from "./types.ts";

export type PublicImportReport = {
  version: 1;
  source: {
    archivePath: string;
    archiveBytes: number;
  };
  counts: NotionImport["report"];
  failures: NotionImport["diagnostics"]["conversionFailures"];
  publish?: {
    mode: "dry-run";
    complete: boolean;
    validationPassed: boolean;
    readyForSigning: boolean;
    readyToPublish: false;
    inputPageCount: number;
    unsignedEventCount: number;
    failureCount: number;
    rejectedParentCount: number;
    dependentEventCount: number;
    minFailureBytes: number | null;
    maxFailureBytes: number | null;
    livePublished: false;
    failures: PublishFailure[];
    contentLimit: DryRunOutput["contentLimit"];
    assetPreparation: DryRunOutput["assetPreparation"];
  };
  notes: {
    restoredLinkDefinition: string;
    docsNavigationLimitation: string;
    relationDefinition: string;
    databaseDefinition: string;
    diagnostics: string;
  };
};

export function buildPublicReport(
  imported: NotionImport,
  dryRun?: DryRunOutput,
): PublicImportReport {
  return {
    version: 1,
    source: imported.source,
    counts: imported.report,
    failures: imported.diagnostics.conversionFailures,
    ...(dryRun
      ? {
          publish: {
            mode: "dry-run" as const,
            complete: dryRun.complete,
            validationPassed: dryRun.validationPassed,
            readyForSigning: dryRun.readyForSigning,
            readyToPublish: false as const,
            inputPageCount: dryRun.inputPageCount,
            unsignedEventCount: dryRun.events.length,
            failureCount: dryRun.failures.length,
            rejectedParentCount: dryRun.rejectedParentCount,
            dependentEventCount: dryRun.dependentEventCount,
            minFailureBytes:
              dryRun.failures.length === 0
                ? null
                : Math.min(...dryRun.failures.map((failure) => failure.bytes)),
            maxFailureBytes:
              dryRun.failures.length === 0
                ? null
                : Math.max(...dryRun.failures.map((failure) => failure.bytes)),
            livePublished: false as const,
            failures: dryRun.failures,
            contentLimit: dryRun.contentLimit,
            assetPreparation: dryRun.assetPreparation,
          },
        }
      : {}),
    notes: {
      restoredLinkDefinition:
        "A restored link is a Notion page target rewritten to the existing /#/docs/<pageId> route.",
      docsNavigationLimitation:
        "In-app Docs navigation: not available. The current Markdown renderer handles this as a regular external link.",
      relationDefinition:
        "Only columns explicitly named with --relation-column are treated as relations; exact unique page titles become links and ambiguous titles stay text.",
      databaseDefinition:
        "databaseCount and databaseRowCount count canonical _all.csv files; databaseCsvFileCount counts every CSV file.",
      diagnostics:
        "Detailed unresolved-link, parent, relation, and syntax records are in the untracked intermediate and diagnostics JSON files.",
    },
  };
}

function metric(label: string, value: number): string {
  return `| ${label} | ${value.toLocaleString("en-US")} |`;
}

export function renderMarkdownReport(
  imported: NotionImport,
  dryRun?: DryRunOutput,
): string {
  const { report } = imported;
  const unsupported = Object.entries(report.unsupportedSyntax).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  const failures = imported.diagnostics.conversionFailures;
  return [
    "# Notion import report",
    "",
    "## 결론",
    "",
    failures.length === 0
      ? `Markdown 페이지 ${report.pageCount.toLocaleString("en-US")}개를 모두 중간 JSON으로 바꿨다.`
      : `Markdown 페이지 가운데 ${report.pageFailureCount.toLocaleString("en-US")}개는 바꾸지 못했다.`,
    "실제 릴레이 발행은 하지 않았다.",
    ...(dryRun
      ? [
          `dry-run에서 ${dryRun.events.length.toLocaleString("en-US")}개의 unsigned kind-30623 입력을 만들었고 ${dryRun.failures.length.toLocaleString("en-US")}개는 크기 상한으로 제외했다.`,
        ]
      : []),
    "",
    "## 실측 집계",
    "",
    "| 항목 | 수 |",
    "|---|---:|",
    metric("ZIP 파일", report.archiveEntryCount),
    metric("Markdown 파일", report.markdownFileCount),
    metric("변환된 페이지", report.pageCount),
    metric("변환 실패", report.pageFailureCount),
    metric("원래 Notion ID 페이지", report.nativePageIdCount),
    metric("경로 해시 ID 페이지", report.syntheticPageIdCount),
    metric("부모를 못 정해 최상위로 둔 페이지", report.unresolvedParentCount),
    metric("부모 제목이 겹친 폴더", report.ambiguousParentFolderCount),
    metric("DB (_all.csv)", report.databaseCount),
    metric("CSV 파일", report.databaseCsvFileCount),
    metric("DB 행 (_all.csv)", report.databaseRowCount),
    metric("본문에 펼친 DB", report.inlineDatabaseCount),
    metric("Notion 페이지 링크 대상", report.pageLinkTargetCount),
    metric("Docs 경로로 고친 링크", report.linkResolvedCount),
    metric("못 찾은 페이지 링크", report.linkUnresolvedCount),
    metric("관계 링크 복원", report.relationResolvedCount),
    metric("제목이 겹쳐 관계 링크로 못 바꿈", report.relationAmbiguousCount),
    metric("대상 제목을 못 찾은 관계", report.relationUnresolvedCount),
    metric("값이 있는 관계 셀 (_all.csv)", report.relationNonemptyCellCount),
    metric("관계 대상 (_all.csv)", report.relationReferenceCount),
    metric("명시한 관계 열 (_all.csv)", report.relationColumnCount),
    metric("ZIP 안 첨부 파일", report.attachmentFileCount),
    metric("본문의 첨부 참조", report.attachmentReferenceCount),
    "",
    "링크 복원 수는 Notion 페이지 대상을 기존 `/#/docs/<pageId>` 경로로 고친 횟수다.",
    "앱 안 Docs 이동: 못 함 — 현재 Markdown renderer에 Docs 링크 전용 처리가 없다.",
    "DB 수와 행 수는 `_all.csv` 기준이고, CSV 파일 수는 모든 CSV를 센 값이다.",
    "관계는 `--relation-column`으로 지정한 열만 다룬다. 각 관계 대상 제목이 정확히 맞고 그 제목이 유일할 때만 링크로 바꿨다.",
    ...(dryRun
      ? [
          "",
          "## 발행 dry-run",
          "",
          "| 항목 | 수 |",
          "|---|---:|",
          metric("입력 페이지", dryRun.inputPageCount),
          metric("unsigned kind-30623 입력", dryRun.events.length),
          metric(
            "적용 content 상한 (bytes)",
            dryRun.contentLimit.effectiveMaxContentBytes,
          ),
          metric("적용 content 상한 초과", dryRun.failures.length),
          metric("상한 초과 부모 페이지", dryRun.rejectedParentCount),
          metric(
            "실패 페이지를 parentId로 가진 unsigned 입력",
            dryRun.dependentEventCount,
          ),
          metric("본문 data URL 참조", dryRun.assetPreparation.occurrenceCount),
          metric(
            "새 로컬 asset 파일",
            dryRun.assetPreparation.uniqueAssetCount,
          ),
          metric(
            "ZIP 첨부와 같은 새 asset SHA",
            dryRun.assetPreparation.zipAttachmentMatchedUniqueAssetCount,
          ),
          metric(
            "복원 SHA를 확인한 페이지",
            dryRun.assetPreparation.reconstructionVerifiedPageCount,
          ),
          "",
          `배치 완료: ${dryRun.complete ? "예" : "아니오"}. 이벤트 검증: ${dryRun.validationPassed ? "통과" : "실패"}. 서명 준비: ${dryRun.readyForSigning ? "예" : "아니오"}. 발행 준비 완료: 아니오.`,
          `한도 출처: ${dryRun.contentLimit.source}; verified=${dryRun.contentLimit.limitVerified}; reason=${dryRun.contentLimit.reason}; endpoint=${dryRun.contentLimit.relayInfoEndpoint}; info-status=${dryRun.contentLimit.infoEndpointHttpStatus}; used-status=${dryRun.contentLimit.relayInfoHttpStatus}.`,
          `광고값: ${dryRun.contentLimit.advertisedMaxContentBytes ?? "없음"}; 운영 광고 확인: ${dryRun.contentLimit.operationalAdvertisementConfirmed ? "예" : "아니오"}.`,
          "NIP-11 metadata GET만 수행했다. 서명, 키 조회, WebSocket 연결, 실제 발행은 하지 않았다. unsigned 입력은 발행 완료 이벤트가 아니다.",
          ...(dryRun.assetPreparation.assetBindingsComplete
            ? ["본문 data URL의 미완료 asset binding: 없음."]
            : [
                `본문 data URL ${dryRun.assetPreparation.occurrenceCount.toLocaleString("en-US")}개를 ${dryRun.assetPreparation.uniqueAssetCount.toLocaleString("en-US")}개 로컬 파일로 뺐다. 업로드와 최종 URL binding을 하지 않아 서명하거나 발행할 수 없다.`,
                `ZIP 첨부 ${dryRun.assetPreparation.zipAttachmentFileCount.toLocaleString("en-US")}개와 기존 본문 첨부 참조 ${dryRun.assetPreparation.existingAttachmentReferenceCount.toLocaleString("en-US")}개는 새 로컬 asset 분모와 따로 센다.`,
              ]),
          ...(dryRun.failures.length === 0
            ? ["크기 상한 실패: 없음"]
            : [
                "크기 상한 실패:",
                ...dryRun.failures.map(
                  (failure) =>
                    `- page=${failure.pageId} bytes=${failure.bytes} reason=${failure.reason}`,
                ),
              ]),
        ]
      : []),
    "",
    "## 편집기가 그대로 그리지 못하는 문법",
    "",
    ...(unsupported.length === 0
      ? ["없음"]
      : unsupported.map(
          ([kind, count]) =>
            `- ${kind}: ${count.toLocaleString("en-US")}페이지`,
        )),
    "",
    "## 변환 실패",
    "",
    ...(failures.length === 0
      ? ["없음"]
      : failures.map(
          (failure) =>
            `- page=${failure.pageId ?? "unknown"} entry=${failure.entryIndex} reason=${failure.reason}`,
        )),
    "",
    "못 찾은 링크, 모호한 부모·관계, 페이지별 문법 목록은 커밋하지 않는 diagnostics JSON에 있다.",
    "",
  ].join("\n");
}
