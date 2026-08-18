#!/usr/bin/env bash
#
# grant-hive-permissions.sh
#
# Grants an IAM identity (user or role) the AWS permissions Hive needs at
# runtime, per the README's "AWS Permissions Required" section. Intended for
# users on a scoped-down/least-privilege role (e.g. a custom Isengard role)
# who hit permission errors in the Work tab — Admin-role users already have
# everything this grants and do not need to run this.
#
# WHAT THIS DOES
#   1. Detects the IAM identity your current AWS credentials resolve to
#      (via `aws sts get-caller-identity`).
#   2. Creates a new, standalone customer-managed IAM policy named
#      "HiveRuntimePermissions" containing exactly the permissions listed in
#      Hive's README (Transcribe, S3 on your configured bucket, AgentCore
#      Code Interpreter/Browser, AgentCore Gateway, and optionally
#      SageMaker InvokeEndpoint for image generation).
#   3. Attaches that policy to your identity.
#
# WHAT THIS DELIBERATELY DOES NOT DO
#   - It does NOT inline-edit or overwrite any existing role/user policy.
#     It only ever attaches one new, separate managed policy — anything
#     already on your role is left untouched, and this policy can be
#     detached/deleted independently at any time (see "To undo" below).
#   - It does NOT include the Setup Check-only permissions (iam:CreateRole,
#     iam:PutRolePolicy, s3:CreateBucket, bedrock-agentcore:CreateMemory) —
#     those are one-time bootstrapping permissions used exclusively by
#     Hive's in-app "Run Setup Check" feature, not Hive's normal runtime
#     operation. If Setup Check itself reports permission errors, run
#     Setup Check's items from an Admin-role session instead of granting
#     those broader IAM/S3-creation permissions permanently to a
#     day-to-day role.
#   - It does NOT touch roles/users you don't currently control — it only
#     ever acts on the identity your current credentials resolve to.
#
# REQUIREMENTS
#   - AWS CLI v2 installed and configured (credentials that can already run
#     `aws sts get-caller-identity`, `iam:CreatePolicy`, and
#     `iam:AttachRolePolicy`/`iam:AttachUserPolicy` against your own
#     identity — an account admin may need to run this for you if your
#     current session can't self-manage its own IAM permissions).
#   - jq (used to parse `aws sts get-caller-identity` output). If you don't
#     have jq, install it first: `brew install jq` (macOS) or see
#     https://jqlang.org/download/.
#
# USAGE
#   ./grant-hive-permissions.sh
#   ./grant-hive-permissions.sh --bucket my-hive-transcripts   # scope S3 access to one bucket
#   ./grant-hive-permissions.sh --profile my-isengard-profile  # use a specific AWS CLI profile
#   ./grant-hive-permissions.sh --dry-run                      # print the policy JSON, change nothing
#
# TO UNDO
#   aws iam detach-role-policy  --role-name <name> --policy-arn <arn printed at the end>
#   aws iam detach-user-policy  --user-name <name> --policy-arn <arn printed at the end>
#   aws iam delete-policy       --policy-arn <arn printed at the end>
#
set -euo pipefail

POLICY_NAME="HiveRuntimePermissions"
BUCKET_NAME=""
PROFILE_ARGS=()
DRY_RUN=false

usage() {
  grep '^#' "$0" | sed -e 's/^#!.*//' -e 's/^# \{0,1\}//'
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket)
      BUCKET_NAME="${2:-}"
      [[ -z "$BUCKET_NAME" ]] && { echo "Error: --bucket requires a value" >&2; exit 1; }
      shift 2
      ;;
    --profile)
      [[ -z "${2:-}" ]] && { echo "Error: --profile requires a value" >&2; exit 1; }
      PROFILE_ARGS=(--profile "$2")
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

command -v aws >/dev/null 2>&1 || { echo "Error: AWS CLI not found. Install it first: https://aws.amazon.com/cli/" >&2; exit 1; }
command -v jq  >/dev/null 2>&1 || { echo "Error: jq not found. Install it first (e.g. 'brew install jq')." >&2; exit 1; }

echo "==> Checking current AWS identity..."
IDENTITY_JSON="$(aws sts get-caller-identity "${PROFILE_ARGS[@]}" --output json)"
CALLER_ARN="$(echo "$IDENTITY_JSON" | jq -r '.Arn')"
ACCOUNT_ID="$(echo "$IDENTITY_JSON" | jq -r '.Account')"
echo "    Account: $ACCOUNT_ID"
echo "    Identity: $CALLER_ARN"

# Resolve the underlying IAM entity to attach the policy to. STS sessions
# (Isengard/Merlon-issued temporary credentials, or any AssumeRole session)
# report an ARN like:
#   arn:aws:sts::ACCOUNT:assumed-role/ROLE-NAME/SESSION-NAME
# The actual IAM role to attach a policy to is ROLE-NAME — the assumed-role
# *session* itself has no separate identity to attach a policy to. IAM users
# report arn:aws:iam::ACCOUNT:user/USER-NAME directly.
ENTITY_TYPE=""
ENTITY_NAME=""
if [[ "$CALLER_ARN" =~ ^arn:aws:sts::[0-9]+:assumed-role/([^/]+)/.+$ ]]; then
  ENTITY_TYPE="role"
  ENTITY_NAME="${BASH_REMATCH[1]}"
elif [[ "$CALLER_ARN" =~ ^arn:aws:iam::[0-9]+:role/(.+)$ ]]; then
  ENTITY_TYPE="role"
  ENTITY_NAME="${BASH_REMATCH[1]}"
elif [[ "$CALLER_ARN" =~ ^arn:aws:iam::[0-9]+:user/(.+)$ ]]; then
  ENTITY_TYPE="user"
  ENTITY_NAME="${BASH_REMATCH[1]}"
else
  echo "Error: could not determine an IAM role or user from ARN: $CALLER_ARN" >&2
  echo "This script only supports IAM users and (assumed) IAM roles." >&2
  exit 1
fi
echo "    Resolved IAM $ENTITY_TYPE: $ENTITY_NAME"
echo

# S3 statement — scoped to a specific bucket if provided, otherwise a
# reasonable default resource pattern is used with a loud warning, since an
# unscoped Resource:"*" for S3 object actions is broader than Hive actually
# needs (it only ever touches the one bucket configured in Settings).
if [[ -n "$BUCKET_NAME" ]]; then
  S3_RESOURCE="\"arn:aws:s3:::${BUCKET_NAME}/*\""
  echo "==> S3 permissions scoped to bucket: $BUCKET_NAME"
else
  S3_RESOURCE="\"arn:aws:s3:::*/*\""
  echo "==> WARNING: no --bucket provided — S3 permissions will be granted for all buckets in this account (arn:aws:s3:::*/*)."
  echo "    Re-run with --bucket <your-transcription-bucket-name> to scope this down to just the bucket Hive uses."
fi
echo

POLICY_DOCUMENT=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "HiveTranscribe",
      "Effect": "Allow",
      "Action": [
        "transcribe:StartTranscriptionJob",
        "transcribe:GetTranscriptionJob"
      ],
      "Resource": "*"
    },
    {
      "Sid": "HiveTranscribeBucket",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": ${S3_RESOURCE}
    },
    {
      "Sid": "HiveAgentCoreSandboxAndBrowser",
      "Effect": "Allow",
      "Action": [
        "bedrock-agentcore:StartCodeInterpreterSession",
        "bedrock-agentcore:InvokeCodeInterpreter",
        "bedrock-agentcore:StopCodeInterpreterSession",
        "bedrock-agentcore:StartBrowserSession",
        "bedrock-agentcore:StopBrowserSession"
      ],
      "Resource": "*"
    },
    {
      "Sid": "HiveAgentCoreGateway",
      "Effect": "Allow",
      "Action": [
        "bedrock-agentcore:CreateGateway",
        "bedrock-agentcore:CreateGatewayTarget",
        "bedrock-agentcore:ListGateways",
        "bedrock-agentcore:GetGateway",
        "bedrock-agentcore:ListGatewayTargets",
        "bedrock-agentcore:GetGatewayTarget",
        "bedrock-agentcore:InvokeGateway",
        "bedrock-agentcore:InvokeWebSearch"
      ],
      "Resource": "*"
    },
    {
      "Sid": "HiveImageGenerationOptional",
      "Effect": "Allow",
      "Action": [
        "sagemaker:InvokeEndpoint"
      ],
      "Resource": "*"
    }
  ]
}
EOF
)

if $DRY_RUN; then
  echo "==> --dry-run set: no changes will be made. Policy document that WOULD be created:"
  echo "$POLICY_DOCUMENT"
  exit 0
fi

echo "==> Creating IAM policy '$POLICY_NAME'..."
POLICY_ARN=""
if EXISTING_ARN="$(aws iam get-policy --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/${POLICY_NAME}" "${PROFILE_ARGS[@]}" --query 'Policy.Arn' --output text 2>/dev/null)"; then
  echo "    Policy already exists: $EXISTING_ARN"
  echo "    Adding a new policy version instead of creating a duplicate..."
  # IAM keeps at most 5 versions per managed policy — prune the oldest
  # non-default version first if we're at the limit, so this stays
  # re-runnable indefinitely without manual cleanup.
  VERSION_COUNT="$(aws iam list-policy-versions --policy-arn "$EXISTING_ARN" "${PROFILE_ARGS[@]}" --query 'length(Versions)' --output text)"
  if [[ "$VERSION_COUNT" -ge 5 ]]; then
    OLDEST_NON_DEFAULT="$(aws iam list-policy-versions --policy-arn "$EXISTING_ARN" "${PROFILE_ARGS[@]}" --query 'Versions[?IsDefaultVersion==`false`]|sort_by(@,&CreateDate)[0].VersionId' --output text)"
    if [[ -n "$OLDEST_NON_DEFAULT" && "$OLDEST_NON_DEFAULT" != "None" ]]; then
      aws iam delete-policy-version --policy-arn "$EXISTING_ARN" --version-id "$OLDEST_NON_DEFAULT" "${PROFILE_ARGS[@]}"
    fi
  fi
  aws iam create-policy-version \
    --policy-arn "$EXISTING_ARN" \
    --policy-document "$POLICY_DOCUMENT" \
    --set-as-default \
    "${PROFILE_ARGS[@]}" >/dev/null
  POLICY_ARN="$EXISTING_ARN"
else
  POLICY_ARN="$(aws iam create-policy \
    --policy-name "$POLICY_NAME" \
    --description "Runtime permissions for the Hive desktop app (Transcribe, S3, AgentCore Code Interpreter/Browser/Gateway) — see Hive's README AWS Permissions Required section." \
    --policy-document "$POLICY_DOCUMENT" \
    "${PROFILE_ARGS[@]}" \
    --query 'Policy.Arn' --output text)"
  echo "    Created: $POLICY_ARN"
fi
echo

echo "==> Attaching policy to $ENTITY_TYPE '$ENTITY_NAME'..."
if [[ "$ENTITY_TYPE" == "role" ]]; then
  aws iam attach-role-policy --role-name "$ENTITY_NAME" --policy-arn "$POLICY_ARN" "${PROFILE_ARGS[@]}"
else
  aws iam attach-user-policy --user-name "$ENTITY_NAME" --policy-arn "$POLICY_ARN" "${PROFILE_ARGS[@]}"
fi

echo
echo "Done. '$ENTITY_NAME' now has the permissions Hive needs at runtime."
echo "Policy ARN: $POLICY_ARN"
echo
echo "IAM permission changes can take a short time to propagate. If Hive still"
echo "reports a permission error immediately after this, wait a minute and retry."
echo
echo "To undo this later:"
if [[ "$ENTITY_TYPE" == "role" ]]; then
  echo "  aws iam detach-role-policy --role-name $ENTITY_NAME --policy-arn $POLICY_ARN"
else
  echo "  aws iam detach-user-policy --user-name $ENTITY_NAME --policy-arn $POLICY_ARN"
fi
echo "  aws iam delete-policy --policy-arn $POLICY_ARN"
