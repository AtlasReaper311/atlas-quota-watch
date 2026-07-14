# AWS cost guard

`aws-cost-snapshot.py` converts read-only AWS Cost Explorer data into the existing quota snapshot contract. It never creates budgets, changes limits, or shuts down resources.

## IAM

Grant only `ce:GetCostAndUsage` and `ce:GetCostForecast`. Run with an AWS CLI profile dedicated to billing reads.

## Run

```bash
python3 scripts/aws-cost-snapshot.py --monthly-budget 5 --out /tmp/aws.json
node scripts/cost-guard.js --policy ../atlas-infra/policy/cost-guard.json --fixture /tmp/aws.json --report /tmp/aws-report.json --markdown /tmp/aws-report.md
```
