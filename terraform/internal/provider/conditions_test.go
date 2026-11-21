package provider

import (
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

func TestVersionAndDateConditions(t *testing.T) {
	cond := func(attr, op, value string) conditionModel {
		v := types.StringNull()
		if value != "" {
			v = types.StringValue(value)
		}
		return conditionModel{Attribute: types.StringValue(attr), Op: types.StringValue(op), Value: v}
	}
	check := func(c conditionModel) (errs, warns int) {
		var d diag.Diagnostics
		validateConditions([]conditionModel{c}, path.Root("conditions"), &d)
		return d.ErrorsCount(), d.WarningsCount()
	}
	for _, tc := range []struct {
		c           conditionModel
		errs, warns int
		name        string
	}{
		{cond("appVersion", "semver_gte", `"4.10.0"`), 0, 0, "semver string"},
		{cond("appVersion", "semver_gte", `4.1`), 1, 0, "semver needs a string"},
		{cond("signupAt", "before", `"2026-01-01"`), 0, 0, "date string"},
		{cond("signupAt", "after", `1767225600`), 0, 0, "epoch number"},
		{cond("signupAt", "after", `true`), 1, 0, "date needs a string or number"},
		{cond("build", "gt", `"4.10.0"`), 0, 1, "numeric op on a version warns"},
		{cond("appVersion", "lt", `4.1`), 0, 1, "numeric op on a version attribute warns"},
		{cond("age", "gte", `18`), 0, 0, "numeric op on a number"},
	} {
		errs, warns := check(tc.c)
		if errs != tc.errs || warns != tc.warns {
			t.Errorf("%s: %d errors, %d warnings; want %d, %d", tc.name, errs, warns, tc.errs, tc.warns)
		}
	}
	for _, op := range []string{"semver_eq", "semver_neq", "semver_gt", "semver_gte", "semver_lt", "semver_lte", "before", "after"} {
		found := false
		for _, o := range conditionOps {
			found = found || o == op
		}
		if !found {
			t.Errorf("%s missing from conditionOps", op)
		}
	}
}
